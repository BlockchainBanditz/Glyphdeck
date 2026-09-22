// Vercel serverless function: /api/nfts
// Manual lookup: given one or more token IDs, read each one's metadata
// directly from the chain via public RPC. No API key, no wallet scanning,
// no indexer — just a direct, fast, reliable per-token read.

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
const MAX_TOKENS = 10;

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

async function rpcCall(rpcUrl, to, data) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

async function getTokenURI(rpcUrl, contract, tokenId) {
  const data = '0xc87b56dd' + BigInt(tokenId).toString(16).padStart(64, '0');
  const result = await rpcCall(rpcUrl, contract, data);
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
  const { tokenIds, chain = DEFAULT_CHAIN, contract = DEFAULT_CONTRACT } = req.query;

  if (!tokenIds || typeof tokenIds !== 'string') {
    return res.status(400).json({ error: 'Missing "tokenIds" query parameter (e.g. "9743" or "9743,102").' });
  }
  const chainInfo = CHAINS[chain];
  if (!chainInfo) {
    return res.status(400).json({ error: 'Unsupported chain: ' + chain });
  }

  const ids = tokenIds.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_TOKENS);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No valid token IDs provided.' });
  }
  for (const id of ids) {
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'Token IDs must be whole numbers: "' + id + '" is invalid.' });
    }
  }

  try {
    const cards = await Promise.all(ids.map(async (tokenId) => {
      try {
        const uri = await getTokenURI(chainInfo.rpc, contract, tokenId);
        const meta = await getMetadata(uri);
        return {
          id: contract + '-' + tokenId,
          name: meta.name || ('NFT #' + tokenId),
          image: ipfsToHttp(meta.image) || null,
          attributes: meta.attributes || []
        };
      } catch (e) {
        return { id: contract + '-' + tokenId, name: 'NFT #' + tokenId, image: null, attributes: [], error: true };
      }
    }));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ cards });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to load NFT data from the chain.' });
  }
}
