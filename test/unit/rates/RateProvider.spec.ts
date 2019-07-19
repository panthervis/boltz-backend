import Logger from '../../../lib/Logger';
import Database from '../../../lib/db/Database';
import { Network } from '../../../lib/consts/Enums';
import FeeProvider from '../../../lib/rates/FeeProvider';
import RateProvider from '../../../lib/rates/RateProvider';
import PairRepository from '../../../lib/service/PairRepository';
import DataProvider from '../../../lib/rates/data/DataProvider';
import { ChainConfig } from '../../../lib/chain/ChainClient';

FeeProvider.transactionSizes = {
  normalClaim: 140,

  reverseLockup: 153,
  reverseClaim: 138,
};

const rates = {
  LTC: 0.015,
  BTC: 1,
};

const percentageFees = new Map<string, number>([
  ['LTC/BTC', 0.01],
  ['BTC/BTC', 0.005],
]);

const minerFees = {
  BTC: {
    normal: FeeProvider.transactionSizes.normalClaim * 2,
    reverse: {
      lockup: FeeProvider.transactionSizes.reverseLockup * 2,
      claim: FeeProvider.transactionSizes.reverseClaim * 2,
    },
  },
  LTC: {
    normal: FeeProvider.transactionSizes.normalClaim ,
    reverse: {
      lockup: FeeProvider.transactionSizes.reverseLockup,
      claim: FeeProvider.transactionSizes.reverseClaim,
    },
  },
};

jest.mock('../../../lib/rates/FeeProvider', () => {
  return jest.fn().mockImplementation(() => {
    return {
      percentageFees,
      getBaseFee: (chainCurrency: string, isReverse: boolean) => {
        const minerFeesCurrency = chainCurrency === 'BTC' ? minerFees.BTC : minerFees.LTC;

        return isReverse ? minerFeesCurrency.reverse.lockup : minerFeesCurrency.normal;
      },
    };
  });
});

const mockedFeeProvider = <jest.Mock<FeeProvider>><any>FeeProvider;

jest.mock('../../../lib/rates/data/DataProvider', () => {
  return jest.fn().mockImplementation(() => {
    return {
      getPrice: (baseAsset: string) => {
        return new Promise((resolve) => {
          if (baseAsset === 'BTC') {
            resolve(rates.BTC);
          } else {
            resolve(rates.LTC);
          }
        });
      },
    };
  });
});

const mockedDataProvider = <jest.Mock<DataProvider>><any>DataProvider;

describe('RateProvider', () => {
  const currencyConfig = (currency: string) => ({
    symbol: currency,
    network: Network.Regtest,

    maxSwapAmount: 1000000,
    minSwapAmount: 1000,

    timeoutBlockDelta: currency.toUpperCase() === 'BTC' ? 2 : 8,

    minWalletBalance: 0,

    minLocalBalance: 0,
    minRemoteBalance: 0,

    maxZeroConfAmount: 10000,

    chain: {} as any as ChainConfig,
  });

  const btcCurrencyConfig = currencyConfig('BTC');
  const ltcCurrencyConfig = currencyConfig('LTC');

  const rateProvider = new RateProvider(Logger.disabledLogger, mockedFeeProvider(), 0.1, [
    btcCurrencyConfig,
    {
      symbol: 'LTC',
      ...ltcCurrencyConfig,
    },
  ]);

  rateProvider['dataProvider'] = mockedDataProvider();

  const db = new Database(Logger.disabledLogger, ':memory:');
  const pairRepository = new PairRepository();

  beforeAll(async () => {
    await db.init();

    await Promise.all([
      pairRepository.addPair({
        id: 'LTC/BTC',
        base: 'LTC',
        quote: 'BTC',
      }),
      pairRepository.addPair({
        id: 'BTC/BTC',
        base: 'BTC',
        quote: 'BTC',
      }),
    ]);
  });

  test('should init', async () => {
    const dbPairs = await pairRepository.getPairs();
    await rateProvider.init(dbPairs);
  });

  test('should get rates', () => {
    const { pairs } = rateProvider;

    expect(pairs.get('BTC/BTC')!.rate).toEqual(rates.BTC);
    expect(pairs.get('LTC/BTC')!.rate).toEqual(rates.LTC);
  });

  test('should get limits', () => {
    const { pairs } = rateProvider;

    expect(pairs.get('BTC/BTC')!.limits).toEqual({ maximal: btcCurrencyConfig.maxSwapAmount, minimal: btcCurrencyConfig.minSwapAmount });
    expect(pairs.get('LTC/BTC')!.limits).toEqual({
      maximal: ltcCurrencyConfig.maxSwapAmount,
      minimal: Math.floor(ltcCurrencyConfig.minSwapAmount / rates.LTC),
    });
  });

  test('should get percentage fees', () => {
    const { pairs } = rateProvider;

    percentageFees.forEach((_, pairId) => {
      expect(pairs.get(pairId)!.fees.percentage).toEqual(percentageFees.get(pairId)! * 100);
    });
  });

  test('should get miner fees', () => {
    const { pairs } = rateProvider;

    expect(pairs.get('BTC/BTC')!.fees.minerFees).toEqual({ baseAsset: minerFees.BTC, quoteAsset: minerFees.BTC });
    expect(pairs.get('LTC/BTC')!.fees.minerFees).toEqual({ baseAsset: minerFees.LTC, quoteAsset: minerFees.BTC });
  });

  test('should accept 0-conf for amounts lower than threshold', () => {
    // Should return false for undefined maximal allowed amounts
    expect(rateProvider.acceptZeroConf('ETH', 0)).toEqual(false);

    expect(rateProvider.acceptZeroConf('BTC', btcCurrencyConfig.maxZeroConfAmount + 1)).toEqual(false);

    expect(rateProvider.acceptZeroConf('BTC', btcCurrencyConfig.maxZeroConfAmount)).toEqual(true);
    expect(rateProvider.acceptZeroConf('BTC', btcCurrencyConfig.maxZeroConfAmount - 1)).toEqual(true);
  });

  afterAll(async () => {
    rateProvider.disconnect();
  });
});
