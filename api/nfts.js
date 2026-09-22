// Vercel serverless function: /api/nfts
// Reads NFT ownership directly from the chain via public RPC — no API key,
// no third-party indexer, no signup required. Works for any standard ERC721
// contract (doesn't require the optional "enumerable" extension), by:
//   1. Binary-searching for the contract's deployment block (cheap, ~log2(N) calls)
//   2. Reading every Transfer event involving the wallet since then
//   3. Replaying those events to work out current holdings
//   4. Reading each held token's metadata via tokenURI

const CHAINS = {
  'cronos-mainnet': { rpc: 'https://evm.cronos.org' },
  'eth-mainnet': { rpc: 'https://eth.llamarpc.com' },
  'matic-mainnet': { rpc: 'https://polygon-rpc.com' },
  'base-mainnet': { rpc: 'https://mainnet.base.org' },
  'arbitrum-mainnet': { rpc: 'https://arb1.arbitrum.io/rpc' },
  'optimism-mainnet': { rpc: 'https://mainnet.optimism.io' }
};

const DEFAULT_CONTRACT = '0xddea51dd8649e0605770348ceb417c64c1b350c7';
const DEFAULT_CHAIN = 'cronos-mainnet';
const MAX_TOKENS = 30;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_LOG_CALLS = 60; // hard safety cap so a stubborn RPC can't hang the function

function ipfsToHttp(uri) {
  if (!uri) return uri;
  if (uri.startsWith('ipfs://ipfs/')) return 'https://ipfs.io/ipfs/' + uri.slice('ipfs://ipfs/'.length);
  if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice('ipfs://'.length);
  return uri;
}

function decodeAbiString(hex) {
  hex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const offset = parseInt(hex.slice(0, 64), 16) * 2;
  const length = parseInt(hex.slice(offset, offset + 64), 16);
  const strHex = hex.slice(offset + 64, offset + 64 + length * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

function addressToTopic(address) {
  return '0x' + address.toLowerCase().replace('0x', '').padStart(64, '0');
}

async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message || 'RPC error');
    err.rpcError = json.error;
    throw err;
  }
  return json.result;
}

async function getBlockNumber(rpcUrl) {
  const hex = await rpc(rpcUrl, 'eth_blockNumber', []);
  return parseInt(hex, 16);
}

async function getCode(rpcUrl, contract, blockNum) {
  return rpc(rpcUrl, 'eth_getCode', [contract, '0x' + blockNum.toString(16)]);
}

// Binary-search for the block the contract was deployed in.
async function findDeploymentBlock(rpcUrl, contract, latest) {
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await getCode(rpcUrl, contract, mid);
    if (code && code !== '0x') hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Adaptively fetch logs, splitting the range in half whenever the node
// rejects a request for covering too many blocks at once.
async function getLogsAdaptive(rpcUrl, params, fromBlock, toBlock, budget) {
  if (budget.calls >= MAX_LOG_CALLS) throw new Error('Exceeded log-scan budget');
  budget.calls++;
  try {
    return await rpc(rpcUrl, 'eth_getLogs', [Object.assign({}, params, {
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16)
    })]);
  } catch (e) {
    if (fromBlock >= toBlock) throw e; // can't split further
    const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    const [left, right] = await Promise.all([
      getLogsAdaptive(rpcUrl, params, fromBlock, mid, budget),
      getLogsAdaptive(rpcUrl, params, mid + 1, toBlock, budget)
    ]);
    return left.concat(right);
  }
}

async function getTokenURI(rpcUrl, contract, tokenId) {
  const data = '0xc87b56dd' + BigInt(tokenId).toString(16).padStart(64, '0');
  const result = await rpc(rpcUrl, 'eth_call', [{ to: contract, data }, 'latest']);
  return decodeAbiString(result);
}

async function getMetadata(tokenUri) {
  if (tokenUri.startsWith('data:application/json;base64,')) {
    return JSON.parse(Buffer.from(tokenUri.split(',')[1], 'base64').toString('utf8'));
  }
  const res = await fetch(ipfsToHttp(tokenUri));
  if (!res.ok) throw new Error('metadata fetch failed');
  return res.json();
}

export default async function handler(req, res) {
  const { address, chain = DEFAULT_CHAIN, contract = DEFAULT_CONTRACT } = req.query;

  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'Missing "address" query parameter.' });
  }
  const chainInfo = CHAINS[chain];
  if (!chainInfo) {
    return res.status(400).json({ error: 'Unsupported chain: ' + chain });
  }

  try {
    const rpcUrl = chainInfo.rpc;
    const latest = await getBlockNumber(rpcUrl);
    const deployBlock = await findDeploymentBlock(rpcUrl, contract, latest);

    const walletTopic = addressToTopic(address);
    const budget = { calls: 0 };

    const [transfersIn, transfersOut] = await Promise.all([
      getLogsAdaptive(rpcUrl, { address: contract, topics: [TRANSFER_TOPIC, null, walletTopic] }, deployBlock, latest, budget),
      getLogsAdaptive(rpcUrl, { address: contract, topics: [TRANSFER_TOPIC, walletTopic, null] }, deployBlock, latest, budget)
    ]);

    const events = transfersIn.map(l => ({ ...l, dir: 'in' })).concat(transfersOut.map(l => ({ ...l, dir: 'out' })));
    events.sort((a, b) => {
      const bn = parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16);
      if (bn !== 0) return bn;
      return parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16);
    });

    const owned = new Set();
    events.forEach(ev => {
      const tokenId = BigInt(ev.topics[3]).toString();
      if (ev.dir === 'in') owned.add(tokenId); else owned.delete(tokenId);
    });

    const tokenIds = Array.from(owned).slice(0, MAX_TOKENS);

    const cards = await Promise.all(tokenIds.map(async (tokenId) => {
      try {
        const uri = await getTokenURI(rpcUrl, contract, tokenId);
        const meta = await getMetadata(uri);
        return {
          id: contract + '-' + tokenId,
          name: meta.name || ('NFT #' + tokenId),
          image: ipfsToHttp(meta.image) || null,
          attributes: meta.attributes || []
        };
      } catch (e) {
        return { id: contract + '-' + tokenId, name: 'NFT #' + tokenId, image: null, attributes: [] };
      }
    }));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ cards });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to load NFTs from the chain.' });
  }
}
