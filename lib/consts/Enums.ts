export enum ErrorCodePrefix {
  General = 0,
  Grpc = 1,
  Service = 2,
  Wallet = 3,
  Chain = 4,
  Lnd = 5,
  Swap = 6,
  Rates = 7,
  Bakcup = 8,
}

export enum ClientStatus {
  Disconnected,
  Connected,
  OutOfSync,
}

export enum OrderSide {
  BUY,
  SELL,
}

export enum SwapUpdateEvent {
  InvoicePaid = 'invoice.paid',
  InvoiceSettled = 'invoice.settled',
  InvoiceFailedToPay = 'invoice.failedToPay',

  TransactionMempool = 'transaction.mempool',
  TransactionClaimed = 'transaction.claimed',
  TransactionRefunded = 'transaction.refunded',
  TransactionConfirmed = 'transaction.confirmed',

  SwapExpired = 'swap.expired',
}

export enum ServiceWarning {
  ReverseSwapsDisabled = 'reverse.swaps.disabled',
}

export enum Network {
  Mainnet = 'mainnet',
  Testnet = 'testnet',
  Simnet = 'simnet',
  Regtest = 'regtest',
}
