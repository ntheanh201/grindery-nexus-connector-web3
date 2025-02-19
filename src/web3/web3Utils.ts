import Web3 from "web3";
import { AbiItem } from "web3-utils";
import { Subscription } from "web3-core-subscriptions";
import { BlockTransactionObject } from "web3-eth";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { trackSingle } from "../metric";

const CHAIN_MAPPING = {
  "eip155:1": "eth",
  "eip155:42161": "arbitrum",
  "eip155:100": "gnosis",
  "eip155:137": "polygon",
  "eip155:42220": "celo",
  "eip155:43114": "avalanche",
  "eip155:56": "bsc",
  "eip155:250": "fantom",
  "eip155:1666600000": "harmony",

  "eip155:80001": "polygon_mumbai",
  "eip155:25": `wss://cro.getblock.io/mainnet/?api_key=${process.env.GETBLOCK_API_KEY}`
};
class NewBlockSubscriber extends EventEmitter {
  private newBlockSubscription: null | Subscription<unknown> = null;
  private latestBlock = -1;
  private nextBlock = -1;
  private checking = false;
  private closed = false;
  private pollTimer: null | ReturnType<typeof setTimeout> = null;
  private resetSubscriptionTimer: null | ReturnType<typeof setTimeout> = null;
  private numPolled = 0;
  private lastNoBlockTimestamp = 0;
  constructor(private web3: Web3, private web3Full: Web3, private tag: string) {
    super();
    this.resetSubscription();
    this.resetPoller();
  }
  close() {
    this.closed = true;
    this.removeAllListeners();
    this.unsubscribe();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.resetSubscriptionTimer) {
      clearTimeout(this.resetSubscriptionTimer);
      this.resetSubscriptionTimer = null;
    }
  }
  unsubscribe() {
    if (this.newBlockSubscription) {
      this.newBlockSubscription.unsubscribe((err) => {
        if (err) {
          console.error(`[${this.tag}] Failed to unsubscribe from newBlockHeaders`, err);
        }
      });
    }
    this.newBlockSubscription = null;
  }
  resetSubscription() {
    this.unsubscribe();
    if (this.closed) {
      return;
    }
    if (this.resetSubscriptionTimer) {
      clearTimeout(this.resetSubscriptionTimer);
    }
    this.resetSubscriptionTimer = setTimeout(() => {
      this.resetSubscriptionTimer = null;
      if (this.closed) {
        return;
      }
      let connectTimeout = setTimeout(() => {
        connectTimeout = null;
        console.error(`[${this.tag}] Timeout when setting up subscription`);
        this.unsubscribe();
      }, 10000) as ReturnType<typeof setTimeout> | null;
      this.newBlockSubscription = this.web3Full.eth
        .subscribe("newBlockHeaders")
        .on("data", (block) => {
          if (!block.number || block.number <= this.latestBlock) {
            return;
          }
          this.latestBlock = block.number;
          this.checkNewBlocks().catch((e) => console.error(`[${this.tag}] Error in checkNewBlocks`, e));
          this.numPolled = 0;
          this.resetPoller();
        })
        .on("error", (error) => {
          if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
          }
          if (this.closed) {
            return;
          }
          console.error(error);
          this.unsubscribe();
        })
        .on("connected", () => {
          if (connectTimeout) {
            console.log(`[${this.tag}] Connected to subscription`);
            clearTimeout(connectTimeout);
            connectTimeout = null;
          }
        });
    }, 1000);
  }
  async poll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.closed) {
      return;
    }
    try {
      let timeout = setTimeout(() => {
        timeout = null;
        console.error(`[${this.tag}] Timeout in poll, latest block:`, this.latestBlock);
        if (this.closed) {
          return;
        }
        this.emit("error", new Error("Timeout in poll"));
        this.resetPoller();
      }, 30000) as ReturnType<typeof setTimeout> | null;
      this.numPolled++;
      let latestBlock = null as number | null;
      try {
        latestBlock = await this.web3.eth.getBlockNumber();
      } finally {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      }
      if (latestBlock > this.latestBlock) {
        this.latestBlock = latestBlock;
        console.log(`[${this.tag}] Got new block from polling: ${latestBlock}`);
        this.checkNewBlocks().catch((e) => console.error("Error in checkNewBlocks", e));
        if (this.numPolled > 10) {
          this.emit("reconnectProvider");
          this.resetSubscription();
          this.numPolled = 0;
        }
      }
    } catch (e) {
      console.error(`[${this.tag}] Error in poll`, e);
      if (this.numPolled > 10 && this.latestBlock < 0) {
        console.log(`[${this.tag}] Too many errors in poll, stopping`);
        this.emit("stop", e);
        this.close();
      }
    }
    this.resetPoller();
  }
  resetPoller() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    if (this.closed) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, 30000);
  }
  async checkNewBlocks() {
    if (this.nextBlock <= 0) {
      this.nextBlock = this.latestBlock;
      return;
    }
    if (this.checking) {
      return;
    }
    if (Date.now() - this.lastNoBlockTimestamp < 5000) {
      return;
    }
    this.checking = true;
    if (this.latestBlock - this.nextBlock > 500) {
      console.log(
        `[${this.tag}] Too many blocks behind, skipping some blocks: ${this.nextBlock} -> ${this.latestBlock}`
      );
      this.nextBlock = this.latestBlock;
    }
    try {
      while (this.nextBlock < this.latestBlock - 3) {
        if (this.closed) {
          return;
        }
        const blockWithTransactions: BlockTransactionObject | undefined = await this.web3.eth
          .getBlock(this.nextBlock, true)
          .catch((e) => {
            if (this.closed) {
              return;
            }
            console.error(`[${this.tag}] Error getting block:`, e);
            return undefined;
          });
        if (!blockWithTransactions) {
          console.log(`[${this.tag}] No block`, this.nextBlock);
          this.lastNoBlockTimestamp = Date.now();
          return;
        }
        this.nextBlock++;
        if (!blockWithTransactions.transactions) {
          console.log(`[${this.tag}] No transactions in block`, blockWithTransactions.number, blockWithTransactions);
          return;
        }
        this.emit("newBlock", blockWithTransactions);
      }
    } catch (e) {
      if (this.closed) {
        return;
      }
      console.error(`[${this.tag}] Error in checkNewBlocks`, e);
      this.emit("error", e);
    } finally {
      this.checking = false;
    }
  }
}
function instrumentProvider<T extends { send: (payload, callback) => void }>(
  provider: T,
  extraTags: Record<string, string>
): T {
  const originalSend = provider.send;
  provider.send = function (payload) {
    for (const request of Array.isArray(payload) ? payload : [payload]) {
      if (!request.method) {
        console.log("instrumentProvider: Unexpected payload", { payload });
        continue;
      }
      trackSingle("web3ApiCalls", { ...extraTags, method: request.method });
    }
    // eslint-disable-next-line prefer-rest-params, @typescript-eslint/no-explicit-any
    return originalSend.apply(this, arguments as any);
  };
  return provider;
}
class Web3Wrapper extends EventEmitter {
  private ref = 1;
  public readonly web3: Web3;
  private readonly web3Full: Web3;
  private provider: InstanceType<typeof Web3.providers.WebsocketProvider>;
  private newBlockSubscriber: null | NewBlockSubscriber = null;
  private reconnectTimer: null | ReturnType<typeof setTimeout> = null;
  private reconnectCount = 0;
  constructor(private url: string, urlHttp = "") {
    super();
    this.setMaxListeners(1000);
    console.log(`[${this.redactedUrl()}] Creating web3 wrapper`);
    this.provider = this.createProvider();
    this.web3Full = new Web3(this.provider);
    this.web3 = urlHttp
      ? new Web3(
          instrumentProvider(new Web3.providers.HttpProvider(urlHttp, { timeout: 15000 }), {
            url: this.redactedUrl(),
            type: "http",
          })
        )
      : this.web3Full;
  }
  private createProvider() {
    this.provider = instrumentProvider(
      new Web3.providers.WebsocketProvider(this.url, {
        timeout: 15000,
        reconnect: {
          auto: false,
        },
        clientConfig: {
          maxReceivedFrameSize: 4000000,
          maxReceivedMessageSize: 16000000,
        },
      }),
      { url: this.redactedUrl(), type: "ws" }
    );
    this.provider.on("error", ((e) => {
      console.error("WS provider error", e);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    return this.provider;
  }

  redactedUrl() {
    return this.url.replace(/[0-9a-f]{8,}/i, "***");
  }
  close() {
    if (this.ref <= 0) {
      return;
    }
    this.ref--;
    if (this.ref <= 0) {
      console.log(`[${this.redactedUrl()}] Closing web3 wrapper`);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.newBlockSubscriber) {
        this.newBlockSubscriber.close();
        this.newBlockSubscriber = null;
      }
      this.web3.eth.clearSubscriptions(() => {
        /* Ignore */
      });
      this.web3.setProvider(null);
      this.web3Full.setProvider(null);
      this.provider.reset();
      this.provider.disconnect();
      this.emit("close");
      this.removeAllListeners();
    }
  }
  isClosed() {
    return this.ref <= 0;
  }
  addRef() {
    if (this.ref <= 0) {
      throw new Error("Web3Wrapper already closed");
    }
    this.ref++;
  }
  private reconnectProvider() {
    if (this.isClosed()) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectCount++;
    const reconnectCount = this.reconnectCount;
    if (this.provider.connection && this.provider.connection.readyState === WebSocket.OPEN) {
      this.provider.connection.close();
    }
    this.reconnectTimer = setTimeout(() => {
      if (this.reconnectCount !== reconnectCount) {
        return;
      }
      this.reconnectTimer = null;
      if (this.provider.connection && this.provider.connection.readyState === WebSocket.OPEN) {
        this.provider.connection.close();
      }
      if (this.isClosed()) {
        return;
      }
      setTimeout(() => {
        if (this.reconnectCount !== reconnectCount) {
          return;
        }
        if (this.isClosed()) {
          return;
        }
        this.provider.reset();
        this.createProvider();
        this.web3Full.setProvider(this.provider);
        setTimeout(() => {
          if (this.isClosed()) {
            return;
          }
          if (this.reconnectCount === reconnectCount) {
            this.reconnectCount = 0;
          }
        }, 60000);
      }, 100);
    }, 100 * Math.pow(2, this.reconnectCount));
  }
  private subscribeToNewBlockHeader() {
    if (this.isClosed()) {
      return;
    }
    if (!this.reconnectTimer) {
      this.reconnectCount = 0;
    }
    if (!this.newBlockSubscriber) {
      this.newBlockSubscriber = new NewBlockSubscriber(this.web3, this.web3Full, this.redactedUrl());
      this.newBlockSubscriber.on("newBlock", (block) => {
        if (this.listenerCount("newBlock") === 0) {
          console.log(`[${this.redactedUrl()}] No listeners for newBlock, closing subscription`);
          this.newBlockSubscriber?.close();
          this.newBlockSubscriber = null;
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callOnceMemo = new Map<string, any>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callOnce = function (key: string, call: () => any) {
          if (!callOnceMemo.has(key)) {
            callOnceMemo.set(key, call());
          }
          return callOnceMemo.get(key);
        };
        this.emit("newBlock", block, callOnce);
      });
      this.newBlockSubscriber.on("reconnectProvider", () => {
        console.log(`[${this.redactedUrl()}] Trying to reconnect to WebSocket provider`);
        this.reconnectProvider();
      });
      this.newBlockSubscriber.on("error", (e) => {
        console.error(`[${this.redactedUrl()}] Error in newBlockSubscriber`, e);
      });
      this.newBlockSubscriber.on("stop", (e) => {
        this.emit("error", e);
        this.newBlockSubscriber?.close();
        this.newBlockSubscriber = null;
        this.ref = 1;
        this.close();
      });
    }
  }
  onNewBlock(
    callback: (block: BlockTransactionObject, callOnce: <T>(key: string, call: () => T) => T) => void,
    onError: (e: Error) => void
  ) {
    if (this.isClosed()) {
      throw new Error("Web3Wrapper is closed");
    }
    this.addListener("newBlock", callback);
    this.addListener("error", onError);
    if (!this.newBlockSubscriber) {
      this.subscribeToNewBlockHeader();
    }
    return () => {
      this.removeListener("newBlock", callback);
      this.removeListener("error", onError);
    };
  }
}
const web3Cache = new Map<string, Web3Wrapper>();
export function getWeb3(chain = "eth") {
  const isRawUrl = CHAIN_MAPPING[chain]?.includes("://");
  const url = isRawUrl
    ? CHAIN_MAPPING[chain]
    : `wss://rpc.ankr.com/${CHAIN_MAPPING[chain] || chain}/ws/${process.env.ANKR_KEY}`;
  const urlHttp = isRawUrl ? "" : `https://rpc.ankr.com/${CHAIN_MAPPING[chain] || chain}/${process.env.ANKR_KEY}`;
  let wrapper = web3Cache.get(url);
  if (!wrapper || wrapper.isClosed()) {
    wrapper = new Web3Wrapper(url, urlHttp);
    web3Cache.set(url, wrapper);
    wrapper.on("close", () => {
      if (web3Cache.get(url) === wrapper) {
        web3Cache.delete(url);
      }
    });
  } else {
    wrapper.addRef();
  }
  return {
    web3: wrapper.web3,
    close: () => {
      wrapper?.close();
      wrapper = undefined;
    },
    onNewBlock: wrapper?.onNewBlock.bind(wrapper),
    web3Wrapper: wrapper,
  };
}
export function onNewBlockMultiChain(
  chains: string | string[],
  callback: (params: {
    chain: string;
    web3: Web3;
    block: BlockTransactionObject;
    callOnce: <T>(key: string, call: () => T) => T;
  }) => Promise<void>,
  onError: (e: Error) => void
): () => void {
  if (chains.length === 0) {
    throw new Error("No chains specified");
  }
  if (typeof chains === "string") {
    chains = [chains];
  }
  const cleanUpFunctions = [] as (() => void)[];
  for (const chain of chains) {
    const { web3, close, onNewBlock, web3Wrapper } = getWeb3(chain);
    const onClose = () => {
      onError(new Error(`Web3Wrapper for ${chain} closed`));
    };
    web3Wrapper.on("close", onClose);
    cleanUpFunctions.push(() => {
      web3Wrapper.off("close", onClose);
    });
    cleanUpFunctions.push(
      onNewBlock(
        (block, callOnce) => Promise.resolve(callback({ chain, web3, block, callOnce })).catch(onError),
        onError
      )
    );
    cleanUpFunctions.push(close);
  }
  return () => {
    for (const cleanUpFunction of cleanUpFunctions) {
      cleanUpFunction();
    }
    cleanUpFunctions.splice(0, cleanUpFunctions.length);
  };
}
export function isSameAddress(a, b) {
  if (!a || !b) {
    return false;
  }
  if (/^0x/.test(a) && /^0x/.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
export function parseEventDeclaration(eventDeclaration: string): AbiItem {
  const m = /^\s*(event +)?([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*;?\s*$/.exec(eventDeclaration);
  if (!m) {
    throw new Error("Invalid event declaration");
  }
  const name = m[2];
  const inputs = m[3].split(",").map((p) => {
    const parts = p.trim().split(/\s+/);
    if (parts.length !== 2 && parts.length !== 3) {
      throw new Error("Invalid event declaration: Invalid parameter " + p);
    }
    if (parts.length === 3 && parts[1] !== "indexed") {
      throw new Error("Invalid event declaration: Invalid parameter " + p);
    }
    return {
      indexed: parts.length === 3,
      type: parts[0],
      name: parts[parts.length - 1],
    };
  });
  return {
    name,
    inputs,
    type: "event",
    anonymous: false,
  };
}
export function parseFunctionDeclaration(functionDeclaration: string): AbiItem {
  const m = /^\s*(function +)?([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*(.*)$/.exec(functionDeclaration);
  if (!m) {
    throw new Error("Invalid function declaration");
  }
  const name = m[2];
  const inputs = m[3].split(",").map((p) => {
    const parts = p.trim().split(/\s+/);
    if (parts.length < 2) {
      throw new Error("Invalid function declaration: Invalid parameter " + p);
    }
    return {
      type: parts[0],
      name: parts[parts.length - 1],
    };
  });
  const suffixes = m[4].trim().split(/\s+/);
  return {
    name,
    inputs,
    constant: suffixes.includes("view"),
    payable: suffixes.includes("payable"),
    stateMutability: suffixes.includes("pure")
      ? "pure"
      : suffixes.includes("view")
      ? "view"
      : suffixes.includes("payable")
      ? "payable"
      : "nonpayable",
    type: "function",
  };
}
