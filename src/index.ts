/*! micro-eth-signer - MIT License (c) 2021 Paul Miller (paulmillr.com) */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { UnwrapCoder } from 'micro-packed';
import { addr } from './address.js';
// prettier-ignore
import {
  TxType, TxVersions, TxCoder, RawTx,
  decodeLegacyV, removeSig, sortRawData, validateFields,
  AuthorizationItem, AuthorizationRequest, authorizationRequest
} from './tx.js';
import { RLP } from './rlp.js';
// prettier-ignore
import {
  amounts, astr, ethHex, ethHexNoLeadingZero, strip0x, weieth, weigwei, cloneDeep,
} from './utils.js';
export { addr, weigwei, weieth };

// The file exports Transaction, but actual (RLP) parsing logic is done in `./tx`

/**
 * EIP-7702 Authorizations
 */
export const authorization = {
  _getHash(req: AuthorizationRequest) {
    const msg = RLP.encode(authorizationRequest.decode(req));
    return keccak_256(concatBytes(new Uint8Array([0x05]), msg));
  },
  sign(req: AuthorizationRequest, privateKey: string): AuthorizationItem {
    astr(privateKey);
    const sig = secp256k1.sign(this._getHash(req), ethHex.decode(privateKey));
    return { ...req, r: sig.r, s: sig.s, yParity: sig.recovery };
  },
  getAuthority(item: AuthorizationItem) {
    const { r, s, yParity, ...req } = item;
    const hash = this._getHash(req);
    const sig = new secp256k1.Signature(r, s).addRecoveryBit(yParity);
    const point = sig.recoverPublicKey(hash);
    return addr.fromPublicKey(point.toHex(false));
  },
};
// Transaction-related utils.

// 4 fields are required. Others are pre-filled with default values.
const DEFAULTS = {
  accessList: [], // needs to be .slice()-d to create new reference
  authorizationList: [],
  chainId: 1n, // mainnet
  data: '',
  gasLimit: 21000n, // TODO: investigate if limit is smaller in eip4844 txs
  maxPriorityFeePerGas: 1n * amounts.GWEI, // Reduce fingerprinting by using standard, popular value
  type: 'eip1559',
} as const;
type DefaultField = keyof typeof DEFAULTS;
type DefaultType = (typeof DEFAULTS)['type'];
type DefaultsOptional<T> = {
  [P in keyof T as P extends DefaultField ? P : never]?: T[P];
} & {
  [P in keyof T as P extends DefaultField ? never : P]: T[P];
};
type HumanInputInner<T extends TxType> = DefaultsOptional<{ type: T } & TxCoder<T>>;
type HumanInputInnerDefault = DefaultsOptional<TxCoder<DefaultType>>;
type Required<T> = T extends undefined ? never : T;
type HumanInput<T extends TxType | undefined> = T extends undefined
  ? HumanInputInnerDefault
  : HumanInputInner<Required<T>>;
type TxVersions = typeof TxVersions;
type SpecifyVersion<T extends TxType[]> = UnwrapCoder<
  {
    [K in keyof TxVersions]: K extends T[number] ? TxVersions[K] : never;
  }[keyof TxVersions]
>;
type SpecifyVersionNeg<T extends TxType[]> = UnwrapCoder<
  Exclude<
    {
      [K in keyof TxVersions]: TxVersions[K];
    }[keyof TxVersions],
    {
      [K in keyof TxVersions]: K extends T[number] ? TxVersions[K] : never;
    }[keyof TxVersions]
  >
>;

// Changes:
// - legacy: instead of hardfork now accepts additional param chainId
//           if chainId is present, we enable relay protection
//           This removes hardfork param and simplifies replay protection logic
// - tx parametrized over type: you cannot access fields from different tx version
// - legacy: 'v' param is hidden in coders. Transaction operates in terms chainId and yParity.
// TODO: tx is kinda immutable, but user can change .raw values before signing
// need to think about re-validation?
export class Transaction<T extends TxType> {
  isSigned: boolean;

  // Doesn't force any defaults, catches if fields incompatible with type
  constructor(
    readonly type: T,
    readonly raw: TxCoder<T>,
    strict = true,
    allowSignatureFields = true
  ) {
    validateFields(type, raw, strict, allowSignatureFields);
    this.isSigned = typeof raw.r === 'bigint' && typeof raw.s === 'bigint';
  }
  // Defaults
  static prepare<T extends { type: undefined }>(
    data: T & HumanInputInnerDefault,
    strict?: boolean
  ): Transaction<(typeof DEFAULTS)['type']>;
  static prepare<TT extends TxType, T extends { type: TT } & HumanInput<TT>>(
    data: HumanInput<TT>,
    strict?: boolean
  ): Transaction<T['type']>;
  static prepare<T extends TxType>(data: HumanInput<T>, strict = true): Transaction<T> {
    const type = (data.type !== undefined ? data.type : DEFAULTS.type) as T;
    if (!TxVersions.hasOwnProperty(type)) throw new Error(`wrong transaction type=${type}`);
    const coder = TxVersions[type];
    const fields = new Set(coder.fields as string[]);
    // Copy default fields, but only if the field is present on the tx type.
    const raw: Record<string, any> = { type };
    for (const f in DEFAULTS) {
      if (f !== 'type' && fields.has(f)) {
        raw[f] = DEFAULTS[f as DefaultField];
        if (['accessList', 'authorizationList'].includes(f)) raw[f] = cloneDeep(raw[f]);
      }
    }
    // Copy all fields, so we can validate unexpected ones.
    return new Transaction(type, sortRawData(Object.assign(raw, data)), strict, false);
  }
  /**
   * Creates transaction which sends whole account balance. Does two things:
   * 1. `amount = accountBalance - maxFeePerGas * gasLimit`
   * 2. `maxPriorityFeePerGas = maxFeePerGas`
   *
   * Every eth block sets a fee for all its transactions, called base fee.
   * maxFeePerGas indicates how much gas user is able to spend in the worst case.
   * If the block's base fee is 5 gwei, while user is able to spend 10 gwei in maxFeePerGas,
   * the transaction would only consume 5 gwei. That means, base fee is unknown
   * before the transaction is included in a block.
   *
   * By setting priorityFee to maxFee, we make the process deterministic:
   * `maxFee = 10, maxPriority = 10, baseFee = 5` would always spend 10 gwei.
   * In the end, the balance would become 0.
   *
   * WARNING: using the method would decrease privacy of a transfer, because
   * payments for services have specific amounts, and not *the whole amount*.
   * @param accountBalance - account balance in wei
   * @param burnRemaining - send unspent fee to miners. When false, some "small amount" would remain
   * @returns new transaction with adjusted amounts
   */
  setWholeAmount(accountBalance: bigint, burnRemaining = true): Transaction<T> {
    if (typeof accountBalance !== 'bigint' || accountBalance <= 0n)
      throw new Error('account balance must be bigger than 0');
    const fee = this.fee;
    const amountToSend = accountBalance - fee;
    if (amountToSend <= 0n) throw new Error('account balance must be bigger than fee of ' + fee);
    const raw = { ...this.raw, value: amountToSend };
    if (!['legacy', 'eip2930'].includes(this.type) && burnRemaining) {
      const r = raw as SpecifyVersionNeg<['legacy', 'eip2930']>;
      r.maxPriorityFeePerGas = r.maxFeePerGas;
    }
    return new Transaction(this.type, raw);
  }
  static fromRawBytes(bytes: Uint8Array, strict = false) {
    const raw = RawTx.decode(bytes);
    return new Transaction(raw.type, raw.data, strict);
  }
  static fromHex(hex: string, strict = false) {
    return Transaction.fromRawBytes(ethHexNoLeadingZero.decode(hex), strict);
  }
  private assertIsSigned() {
    if (!this.isSigned) throw new Error('expected signed transaction');
  }
  /**
   * Converts transaction to RLP.
   * @param includeSignature whether to include signature
   */
  toRawBytes(includeSignature = this.isSigned) {
    // cloneDeep is not necessary here
    let data = Object.assign({}, this.raw);
    if (includeSignature) {
      this.assertIsSigned();
    } else {
      removeSig(data);
    }
    return RawTx.encode({ type: this.type, data } as any); // TODO: remove any
  }
  /**
   * Converts transaction to hex.
   * @param includeSignature whether to include signature
   */
  toHex(includeSignature = this.isSigned) {
    return ethHex.encode(this.toRawBytes(includeSignature));
  }
  /**
   * Calculates keccak-256 hash of signed transaction. Used in block explorers.
   */
  get hash() {
    this.assertIsSigned();
    return this.calcHash(true);
  }
  /**
   * Returns sender's address.
   */
  get sender() {
    return this.recoverSender().address;
  }
  /**
   * For legacy transactions, but can be used with libraries when yParity presented as v.
   */
  get v() {
    return decodeLegacyV(this.raw);
  }
  private calcHash(includeSignature: boolean) {
    return bytesToHex(keccak_256(this.toRawBytes(includeSignature)));
  }
  // Calculates MAXIMUM fee in wei that could be spent
  get fee() {
    const { type, raw } = this;
    // Fee calculation is not exact, real fee can be smaller
    let gasFee;
    if (type === 'legacy' || type === 'eip2930') {
      // Because TypeScript is not smart enough to narrow down types here :(
      const r = raw as SpecifyVersion<['legacy', 'eip2930']>;
      gasFee = r.gasPrice;
    } else {
      const r = raw as SpecifyVersionNeg<['legacy', 'eip2930']>;
      // maxFeePerGas is absolute limit, you never pay more than that
      // maxFeePerGas = baseFeePerGas[*2] + maxPriorityFeePerGas
      gasFee = r.maxFeePerGas;
    }
    // TODO: how to calculate 4844 fee?
    return raw.gasLimit * gasFee;
  }
  clone() {
    return new Transaction(this.type, cloneDeep(this.raw));
  }
  verifySignature() {
    this.assertIsSigned();
    const { r, s } = this.raw;
    return secp256k1.verify({ r: r!, s: s! }, this.calcHash(false), this.recoverSender().publicKey);
  }
  removeSignature() {
    return new Transaction(this.type, removeSig(cloneDeep(this.raw)));
  }
  /**
   * Signs transaction with a private key.
   * @param privateKey key in hex or Uint8Array format
   * @param opts extraEntropy will increase security of sig by mixing rfc6979 randomness
   * @returns new "same" transaction, but signed
   */
  signBy(privateKey: string | Uint8Array, opts: { extraEntropy?: true | undefined } = {}) {
    if (this.isSigned) throw new Error('expected unsigned transaction');
    const priv = typeof privateKey === 'string' ? strip0x(privateKey) : privateKey;
    const hash = this.calcHash(false);
    const { r, s, recovery } = secp256k1.sign(hash, priv, { extraEntropy: opts.extraEntropy });
    const sraw = Object.assign(cloneDeep(this.raw), { r, s, yParity: recovery });
    // The copied result is validated in non-strict way, strict is only for user input.
    return new Transaction(this.type, sraw, false);
  }
  /**
   * Calculates public key and address from signed transaction's signature.
   */
  recoverSender() {
    this.assertIsSigned();
    const { r, s, yParity } = this.raw;
    const sig = new secp256k1.Signature(r!, s!).addRecoveryBit(yParity!);
    // Will crash on 'chainstart' hardfork
    if (sig.hasHighS()) throw new Error('invalid s');
    const point = sig.recoverPublicKey(this.calcHash(false));
    return { publicKey: point.toHex(true), address: addr.fromPublicKey(point.toHex(false)) };
  }
}
