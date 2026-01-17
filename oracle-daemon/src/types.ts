/**
 * Governance proposal status values
 */
export type ProposalStatus = 'active' | 'passed' | 'failed' | 'funded' | 'expired';

/**
 * Masternode vote outcome values
 */
export type VoteOutcome = 'yes' | 'no' | 'abstain';

/**
 * Raw governance object from Dash Core RPC
 */
export interface GovernanceObject {
  Hash: string;
  CollateralHash: string;
  ObjectType: number;
  CreationTime: number;
  FundingResult: {
    AbsoluteYesCount: number;
    YesCount: number;
    NoCount: number;
    AbstainCount: number;
  };
  ValidResult: {
    IsValid: boolean;
    IsValidReason: string;
  };
  DeleteResult: {
    IsDeleted: boolean;
  };
  EndorsedResult: {
    IsEndorsed: boolean;
  };
  DataHex: string;
  DataString: string;
  fLocalValidity: boolean;
  IsValidReason: string;
  fCachedValid: boolean;
  fCachedFunding: boolean;
  fCachedDelete: boolean;
  fCachedEndorsed: boolean;
}

/**
 * Parsed proposal data from DataString
 */
export interface ProposalDataString {
  end_epoch: number;
  name: string;
  payment_address: string;
  payment_amount: number;
  start_epoch: number;
  type: number;
  url: string;
}

/**
 * Transformed proposal data for Platform document
 */
export interface ProposalData {
  proposalHash: string;
  gobjectType: number;
  name: string;
  url: string;
  paymentAddress: string;
  paymentAmount: number; // In duffs
  startEpoch: number;
  endEpoch: number;
  status: ProposalStatus;
  yesCount: number;
  noCount: number;
  abstainCount: number;
  totalMasternodes: number;
  fundingThreshold: number;
  lastUpdatedAt: number;
  createdAtBlockHeight?: number;
  collateralHash?: string;
  collateralPubKey?: string;
}

/**
 * Masternode list entry from Dash Core
 */
export interface MasternodeListEntry {
  proTxHash: string;
  address: string;
  payee: string;
  status: string;
  ownerAddress?: string;
  votingAddress?: string;
  pubKeyOperator?: string;
}

/**
 * Masternode count response from Dash Core
 */
export interface MasternodeCount {
  total: number;
  enabled: number;
}

/**
 * Transformed masternode record for Platform document
 */
export interface MasternodeData {
  proTxHash: string;
  votingKeyHash: string;
  ownerKeyHash?: string;
  payoutAddress?: string;
  isEnabled: boolean;
  lastUpdatedAt: number;
}

/**
 * Vote record from Dash Core
 */
export interface VoteRecord {
  proTxHash: string;
  outcome: VoteOutcome;
  timestamp: number;
  voteHash?: string;
}

/**
 * Transformed vote data for Platform document
 */
export interface VoteData {
  proposalHash: string;
  proTxHash: string;
  outcome: VoteOutcome;
  timestamp: number;
  voteSignature?: string;
}

/**
 * Sync result for tracking operation outcomes
 */
export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  errors: number;
  durationMs: number;
}

/**
 * Health check status
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  checks: {
    dashCore: {
      connected: boolean;
      lastCheck: number;
      blockHeight?: number;
    };
    platform: {
      connected: boolean;
      lastCheck: number;
      credits?: number;
    };
    lastSync: {
      proposals: { timestamp: number; success: boolean; count: number };
      votes: { timestamp: number; success: boolean; count: number };
      masternodes: { timestamp: number; success: boolean; count: number };
    };
  };
}

/**
 * Platform document with metadata
 */
export interface PlatformDocument {
  $id: string;
  $ownerId: string;
  $revision: number;
  $createdAt: Date;
  $updatedAt: Date;
  [key: string]: unknown;
}

/**
 * Raw transaction output from Dash Core
 */
export interface TxOutput {
  value: number;
  n: number;
  scriptPubKey: {
    asm: string;
    hex: string;
    type: string;
    addresses?: string[];
    address?: string;
  };
}

/**
 * Raw transaction from Dash Core
 */
export interface RawTransaction {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vout: TxOutput[];
  hex: string;
}
