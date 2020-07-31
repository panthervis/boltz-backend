import fs from 'fs';
import { Arguments } from 'yargs';
import { Networks } from 'boltz-core';
import { generateMnemonic } from 'bip39';
import Api from './api/Api';
import Logger from './Logger';
import Report from './data/Report';
import Database from './db/Database';
import Service from './service/Service';
import VersionCheck from './VersionCheck';
import GrpcServer from './grpc/GrpcServer';
import GrpcService from './grpc/GrpcService';
import LndClient from './lightning/LndClient';
import ChainClient from './chain/ChainClient';
import Config, { ConfigType } from './Config';
import { formatError, stringify } from './Utils';
import BackupScheduler from './backup/BackupScheduler';
import ChainTipRepository from './db/ChainTipRepository';
import WalletManager, { Currency, CurrencyType } from './wallet/WalletManager';
import NotificationProvider from './notifications/NotificationProvider';
import EthereumManager from './wallet/ethereum/EthereumManager';

class Boltz {
  private readonly logger: Logger;
  private readonly config: ConfigType;

  private readonly service!: Service;
  private readonly walletManager: WalletManager;

  private readonly currencies: Map<string, Currency>;

  private db: Database;
  private notifications!: NotificationProvider;

  private api!: Api;
  private grpcServer!: GrpcServer;

  private readonly ethereumManager?: EthereumManager;

  constructor(config: Arguments<any>) {
    this.config = new Config().load(config);
    this.logger = new Logger(this.config.logpath, this.config.loglevel);

    this.db = new Database(this.logger, this.config.dbpath);

    if (this.config.ethereum.providerEndpoint !== '') {
      this.ethereumManager = new EthereumManager(
        this.logger,
        this.config.ethereum,
      );
    } else {
      this.logger.warn('Disabled Ethereum integration because no web3 provider was specified');
    }

    this.currencies = this.parseCurrencies();

    const walletCurrencies = Array.from(this.currencies.values());

    if (fs.existsSync(this.config.mnemonicpath)) {
      this.walletManager = new WalletManager(this.logger, this.config.mnemonicpath, walletCurrencies, this.ethereumManager);
    } else {
      const mnemonic = generateMnemonic();
      this.logger.info(`Generated new mnemonic: ${mnemonic}`);

      this.walletManager = WalletManager.fromMnemonic(this.logger, mnemonic, this.config.mnemonicpath, walletCurrencies, this.ethereumManager);
    }

    try {
      this.service = new Service(
        this.logger,
        this.config,
        this.walletManager,
        this.currencies,
      );

      const backup = new BackupScheduler(
        this.logger,
        this.config.dbpath,
        this.config.backup,
        this.service.eventHandler,
        new Report(
          this.service.swapManager.swapRepository,
          this.service.swapManager.reverseSwapRepository,
        ),
      );

      this.notifications = new NotificationProvider(
        this.logger,
        this.service,
        backup,
        this.config.notification,
        this.config.currencies,
      );

      this.grpcServer = new GrpcServer(
        this.logger,
        this.config.grpc,
        new GrpcService(this.service),
      );

      this.api = new Api(
        this.logger,
        this.config.api,
        this.service,
      );
    } catch (error) {
      this.logger.error(`Could not start Boltz: ${stringify(error)}`);
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    }
  }

  public start = async (): Promise<void> => {
    try {
      await this.db.init();

      const chainTipRepository = new ChainTipRepository();

      for (const [, currency] of this.currencies) {
        if (currency.chainClient) {
          await this.connectChainClient(currency.chainClient, chainTipRepository);

          if (currency.lndClient) {
            await this.connectLnd(currency.lndClient);
          }
        }
      }

      await this.walletManager.init(chainTipRepository);
      await this.service.init(this.config.pairs);

      await this.service.swapManager.init(Array.from(this.currencies.values()));

      await this.notifications.init();

      this.grpcServer.listen();

      await this.api.init();
    } catch (error) {
      this.logger.error(`Could not initialize Boltz: ${formatError(error)}`);
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    }
  }

  private connectChainClient = async (client: ChainClient, chainTipRepository: ChainTipRepository) => {
    const service = `${client.symbol} chain`;

    try {
      await client.connect(chainTipRepository);

      const blockchainInfo = await client.getBlockchainInfo();
      const networkInfo = await client.getNetworkInfo();

      VersionCheck.checkChainClientVersion(client.symbol, networkInfo.version);

      this.logStatus(service, {
        version: networkInfo.version,
        protocolversion: networkInfo.protocolversion,
        connections: networkInfo.connections,
        blocks: blockchainInfo.blocks,
        bestblockhash: blockchainInfo.bestblockhash,
        verificationprogress: blockchainInfo.verificationprogress,
      });
    } catch (error) {
      this.logCouldNotConnect(service, error);
    }
  }

  private connectLnd = async (client: LndClient) => {
    const service = `${client.symbol} LND`;

    try {
      await client.connect();

      const info = await client.getInfo();

      VersionCheck.checkLndVersion(client.symbol, info.version);

      // The featuresMap is just annoying to see on startup
      info.featuresMap = undefined as any;

      this.logStatus(service, info);
    } catch (error) {
      this.logCouldNotConnect(service, error);
    }
  }

  private parseCurrencies = (): Map<string, Currency> => {
    const result = new Map<string, Currency>();

    this.config.currencies.forEach((currency) => {
      try {
        const chainClient = new ChainClient(this.logger, currency.chain, currency.symbol);

        let lndClient: LndClient | undefined;

        if (currency.lnd) {
          lndClient = new LndClient(this.logger, currency.lnd, currency.symbol);
        }

        result.set(currency.symbol, {
          lndClient,
          chainClient,
          symbol: currency.symbol,
          type: CurrencyType.BitcoinLike,
          network: Networks[currency.network],
          limits: {
            ...currency,
          },
        });
      } catch (error) {
        this.logger.warn(`Could not initialize currency ${currency.symbol}: ${error.message}`);
      }
    });

    this.config.ethereum.tokens.forEach((token) => {
      result.set(token.symbol, {
        symbol: token.symbol,
        type: token.symbol === 'ETH' ? CurrencyType.Ether : CurrencyType.ERC20,
        limits: {
          ...token,
        },
        provider: this.ethereumManager?.provider,
      });
    });

    return result;
  }

  private logStatus = (service: string, status: unknown) => {
    this.logger.verbose(`${service} status: ${JSON.stringify(status, undefined, 2)}`);
  }

  private logCouldNotConnect = (service: string, error: any) => {
    this.logger.error(`Could not connect to ${service}: ${formatError(error)}`);
  }
}

export default Boltz;
