"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bytesToHex = exports.PlatformPublisher = void 0;
exports.getPlatformPublisher = getPlatformPublisher;
const evo_sdk_1 = require("@dashevo/evo-sdk");
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const retry_1 = require("../utils/retry");
const hash_utils_1 = require("../utils/hash-utils");
Object.defineProperty(exports, "bytesToHex", { enumerable: true, get: function () { return hash_utils_1.bytesToHex; } });
const crypto_1 = require("crypto");
const logger = (0, logger_1.createLogger)('PlatformPublisher');
// Document type names in the contract
const DOCUMENT_TYPES = {
    proposal: 'proposal',
    masternodeRecord: 'masternodeRecord',
    masternodeVote: 'masternodeVote',
};
class PlatformPublisher {
    constructor() {
        this.sdk = null;
        const config = (0, config_1.getConfig)();
        this.contractId = config.platform.contractId;
        this.identityId = config.platform.identityId;
        this.privateKey = config.platform.privateKey;
    }
    /**
     * Initialize the SDK connection
     */
    async initialize() {
        if (this.sdk) {
            return;
        }
        const config = (0, config_1.getConfig)();
        logger.info('Initializing Platform SDK', {
            network: config.platform.network,
            contractId: this.contractId,
        });
        // Create SDK based on network
        if (config.platform.network === 'testnet') {
            this.sdk = evo_sdk_1.EvoSDK.testnetTrusted({
                settings: {
                    timeoutMs: 30000,
                }
            });
        }
        else {
            this.sdk = evo_sdk_1.EvoSDK.mainnetTrusted({
                settings: {
                    timeoutMs: 30000,
                }
            });
        }
        // Connect to the network
        await this.sdk.connect();
        // Preload the governance contract
        try {
            await this.sdk.contracts.fetch(this.contractId);
            logger.info('Governance contract cached');
        }
        catch (error) {
            logger.error('Failed to fetch governance contract', error);
            throw new Error(`Failed to fetch governance contract: ${this.contractId}`);
        }
        logger.info('Platform SDK initialized successfully');
    }
    /**
     * Disconnect from Platform
     */
    async disconnect() {
        this.sdk = null;
    }
    /**
     * Ensure SDK is initialized
     */
    ensureInitialized() {
        if (!this.sdk) {
            throw new Error('Platform publisher not initialized. Call initialize() first.');
        }
    }
    /**
     * Generate entropy for state transitions
     */
    generateEntropy() {
        return (0, crypto_1.randomBytes)(32).toString('hex');
    }
    /**
     * Query documents by type and conditions
     */
    async queryDocuments(documentType, where, options = {}) {
        this.ensureInitialized();
        const config = (0, config_1.getConfig)();
        return (0, retry_1.withRetry)(async () => {
            const query = {
                dataContractId: this.contractId,
                documentTypeName: documentType,
                where,
            };
            if (options.limit) {
                query.limit = options.limit;
            }
            if (options.orderBy) {
                query.orderBy = options.orderBy;
            }
            const response = await this.sdk.documents.query(query);
            // Convert Map response to array
            const documents = [];
            if (response instanceof Map) {
                for (const doc of response.values()) {
                    if (doc) {
                        const data = typeof doc.toJSON === 'function'
                            ? doc.toJSON()
                            : doc;
                        documents.push(data);
                    }
                }
            }
            return documents;
        }, {
            attempts: config.sync.retryAttempts,
            delayMs: config.sync.retryDelayMs,
            onRetry: (attempt, error) => {
                logger.warn(`Query ${documentType} failed, retrying`, {
                    attempt,
                    error: error.message,
                });
            },
        });
    }
    /**
     * Create a new document
     */
    async createDocument(documentType, data) {
        this.ensureInitialized();
        const config = (0, config_1.getConfig)();
        return (0, retry_1.withRetry)(async () => {
            const result = await this.sdk.documents.create({
                contractId: this.contractId,
                type: documentType,
                ownerId: this.identityId,
                data,
                entropyHex: this.generateEntropy(),
                privateKeyWif: this.privateKey,
            });
            const docId = result.document?.$id || result.$id || 'unknown';
            logger.debug(`Created document: ${docId}`);
            return docId;
        }, {
            attempts: config.sync.retryAttempts,
            delayMs: config.sync.retryDelayMs,
        });
    }
    /**
     * Update an existing document
     */
    async updateDocument(documentType, documentId, data, revision) {
        this.ensureInitialized();
        const config = (0, config_1.getConfig)();
        await (0, retry_1.withRetry)(async () => {
            await this.sdk.documents.replace({
                contractId: this.contractId,
                type: documentType,
                documentId,
                ownerId: this.identityId,
                data,
                revision: BigInt(revision),
                privateKeyWif: this.privateKey,
            });
            logger.debug(`Updated document: ${documentId}`);
        }, {
            attempts: config.sync.retryAttempts,
            delayMs: config.sync.retryDelayMs,
        });
    }
    /**
     * Delete a document
     */
    async deleteDocument(documentType, documentId) {
        this.ensureInitialized();
        const config = (0, config_1.getConfig)();
        await (0, retry_1.withRetry)(async () => {
            await this.sdk.documents.delete({
                contractId: this.contractId,
                type: documentType,
                documentId,
                ownerId: this.identityId,
                privateKeyWif: this.privateKey,
            });
            logger.debug(`Deleted document: ${documentId}`);
        }, {
            attempts: config.sync.retryAttempts,
            delayMs: config.sync.retryDelayMs,
        });
    }
    // ==================== Proposal Operations ====================
    /**
     * Find a proposal by its governance object hash
     */
    async findProposalByHash(proposalHash) {
        // Convert hex hash to byte array for indexed query
        const hashBytes = (0, hash_utils_1.hexToBytes)(proposalHash);
        const documents = await this.queryDocuments(DOCUMENT_TYPES.proposal, [['proposalHash', '==', hashBytes]], { limit: 1 });
        return documents.length > 0 ? documents[0] : null;
    }
    /**
     * Get all proposals
     */
    async getAllProposals() {
        return this.queryDocuments(DOCUMENT_TYPES.proposal, [['$createdAt', '>', 0]], { orderBy: [['$createdAt', 'asc']] });
    }
    /**
     * Get proposals by status
     */
    async getProposalsByStatus(status) {
        return this.queryDocuments(DOCUMENT_TYPES.proposal, [
            ['status', '==', status],
            ['endEpoch', '>', 0], // Required for index
        ], { orderBy: [['status', 'asc'], ['endEpoch', 'asc']] });
    }
    /**
     * Create or update a proposal document
     */
    async upsertProposal(proposal) {
        const existing = await this.findProposalByHash(proposal.proposalHash);
        // Convert hex hashes to byte arrays for storage
        const documentData = {
            proposalHash: (0, hash_utils_1.hexToBytes)(proposal.proposalHash),
            gobjectType: proposal.gobjectType,
            name: proposal.name,
            url: proposal.url,
            paymentAddress: proposal.paymentAddress,
            paymentAmount: proposal.paymentAmount,
            startEpoch: proposal.startEpoch,
            endEpoch: proposal.endEpoch,
            status: proposal.status,
            yesCount: proposal.yesCount,
            noCount: proposal.noCount,
            abstainCount: proposal.abstainCount,
            totalMasternodes: proposal.totalMasternodes,
            fundingThreshold: proposal.fundingThreshold,
            lastUpdatedAt: proposal.lastUpdatedAt,
            ...(proposal.createdAtBlockHeight !== undefined && {
                createdAtBlockHeight: proposal.createdAtBlockHeight,
            }),
            ...(proposal.collateralHash && {
                collateralHash: proposal.collateralHash,
            }),
            ...(proposal.collateralPubKey && {
                collateralPubKey: proposal.collateralPubKey,
            }),
        };
        if (existing) {
            // Check if data has changed
            if (this.hasProposalChanged(existing, proposal)) {
                logger.debug('Updating proposal', { hash: proposal.proposalHash });
                // Get revision from existing document
                const revision = existing.$revision || 1;
                await this.updateDocument(DOCUMENT_TYPES.proposal, existing.$id, {
                    ...documentData,
                }, revision);
                return { created: false };
            }
            logger.debug('Proposal unchanged, skipping', { hash: proposal.proposalHash });
            return { created: false };
        }
        else {
            logger.info('Creating new proposal', { hash: proposal.proposalHash, name: proposal.name });
            await this.createDocument(DOCUMENT_TYPES.proposal, documentData);
            return { created: true };
        }
    }
    /**
     * Check if proposal data has changed (comparing relevant fields)
     */
    hasProposalChanged(existing, proposal) {
        const doc = existing;
        return (doc.status !== proposal.status ||
            doc.yesCount !== proposal.yesCount ||
            doc.noCount !== proposal.noCount ||
            doc.abstainCount !== proposal.abstainCount ||
            doc.totalMasternodes !== proposal.totalMasternodes ||
            doc.fundingThreshold !== proposal.fundingThreshold);
    }
    /**
     * Delete a proposal document
     */
    async deleteProposal(proposalHash) {
        const existing = await this.findProposalByHash(proposalHash);
        if (existing) {
            logger.info('Deleting proposal', { hash: proposalHash });
            await this.deleteDocument(DOCUMENT_TYPES.proposal, existing.$id);
        }
    }
    // ==================== Masternode Record Operations ====================
    /**
     * Find a masternode record by proTxHash
     */
    async findMasternodeByProTxHash(proTxHash) {
        const hashBytes = (0, hash_utils_1.hexToBytes)(proTxHash);
        const documents = await this.queryDocuments(DOCUMENT_TYPES.masternodeRecord, [['proTxHash', '==', hashBytes]], { limit: 1 });
        return documents.length > 0 ? documents[0] : null;
    }
    /**
     * Create or update a masternode record
     */
    async upsertMasternodeRecord(mn) {
        const existing = await this.findMasternodeByProTxHash(mn.proTxHash);
        const documentData = {
            proTxHash: (0, hash_utils_1.hexToBytes)(mn.proTxHash),
            votingKeyHash: (0, hash_utils_1.hexToBytes)(mn.votingKeyHash),
            ...(mn.ownerKeyHash && { ownerKeyHash: (0, hash_utils_1.hexToBytes)(mn.ownerKeyHash) }),
            ...(mn.payoutAddress && { payoutAddress: mn.payoutAddress }),
            isEnabled: mn.isEnabled,
            lastUpdatedAt: mn.lastUpdatedAt,
        };
        if (existing) {
            const doc = existing;
            if (doc.isEnabled !== mn.isEnabled) {
                logger.debug('Updating masternode record', { proTxHash: mn.proTxHash });
                const revision = existing.$revision || 1;
                await this.updateDocument(DOCUMENT_TYPES.masternodeRecord, existing.$id, documentData, revision);
            }
            return { created: false };
        }
        else {
            logger.debug('Creating new masternode record', { proTxHash: mn.proTxHash });
            await this.createDocument(DOCUMENT_TYPES.masternodeRecord, documentData);
            return { created: true };
        }
    }
    // ==================== Vote Operations ====================
    /**
     * Find a vote by proposal and masternode
     */
    async findVote(proposalHash, proTxHash) {
        const proposalHashBytes = (0, hash_utils_1.hexToBytes)(proposalHash);
        const proTxHashBytes = (0, hash_utils_1.hexToBytes)(proTxHash);
        const documents = await this.queryDocuments(DOCUMENT_TYPES.masternodeVote, [
            ['proposalHash', '==', proposalHashBytes],
            ['proTxHash', '==', proTxHashBytes],
        ], { limit: 1 });
        return documents.length > 0 ? documents[0] : null;
    }
    /**
     * Create or update a vote record
     */
    async upsertMasternodeVote(vote) {
        const existing = await this.findVote(vote.proposalHash, vote.proTxHash);
        const documentData = {
            proposalHash: (0, hash_utils_1.hexToBytes)(vote.proposalHash),
            proTxHash: (0, hash_utils_1.hexToBytes)(vote.proTxHash),
            outcome: vote.outcome,
            timestamp: vote.timestamp,
            ...(vote.voteSignature && { voteSignature: vote.voteSignature }),
        };
        if (existing) {
            const doc = existing;
            // Update if outcome or timestamp changed
            if (doc.outcome !== vote.outcome || doc.timestamp !== vote.timestamp) {
                logger.debug('Updating vote', {
                    proposalHash: vote.proposalHash,
                    proTxHash: vote.proTxHash,
                });
                const revision = existing.$revision || 1;
                await this.updateDocument(DOCUMENT_TYPES.masternodeVote, existing.$id, documentData, revision);
            }
            return { created: false };
        }
        else {
            logger.debug('Creating new vote', {
                proposalHash: vote.proposalHash,
                proTxHash: vote.proTxHash,
            });
            await this.createDocument(DOCUMENT_TYPES.masternodeVote, documentData);
            return { created: true };
        }
    }
    /**
     * Get votes for a proposal
     */
    async getVotesForProposal(proposalHash) {
        const hashBytes = (0, hash_utils_1.hexToBytes)(proposalHash);
        return this.queryDocuments(DOCUMENT_TYPES.masternodeVote, [
            ['proposalHash', '==', hashBytes],
            ['outcome', '>', ''], // Required for index
        ], { orderBy: [['proposalHash', 'asc'], ['outcome', 'asc'], ['timestamp', 'asc']] });
    }
}
exports.PlatformPublisher = PlatformPublisher;
// Singleton instance
let publisherInstance = null;
function getPlatformPublisher() {
    if (!publisherInstance) {
        publisherInstance = new PlatformPublisher();
    }
    return publisherInstance;
}
//# sourceMappingURL=platform-publisher.js.map