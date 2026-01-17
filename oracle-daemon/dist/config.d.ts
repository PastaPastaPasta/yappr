export interface OracleConfig {
    dashCore: {
        host: string;
        port: number;
        username: string;
        password: string;
        timeout: number;
    };
    platform: {
        network: 'mainnet' | 'testnet';
        identityId: string;
        privateKey: string;
        contractId: string;
    };
    sync: {
        proposalIntervalMs: number;
        voteIntervalMs: number;
        masternodeIntervalMs: number;
        retryAttempts: number;
        retryDelayMs: number;
    };
    health: {
        port: number;
        enabled: boolean;
    };
    logging: {
        level: 'debug' | 'info' | 'warn' | 'error';
    };
}
export declare function loadConfig(): OracleConfig;
export declare function getConfig(): OracleConfig;
//# sourceMappingURL=config.d.ts.map