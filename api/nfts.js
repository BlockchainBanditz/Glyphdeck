// Vercel serverless function: /api/nfts
// Uses Etherscan's unified V2 API (supports Cronos) for transfer history,
// then reads each token's metadata directly from the chain via public RPC.
// Set ETHERSCAN_API_KEY in your Vercel project's Environment Variables
// (free key from etherscan.io/apis works across all supported chains).

const CHAINS = {
  'cronos-mainnet': { chainId: 25, rpc: 'https://evm.cronos.org' },
  'eth-mainnet': { chainId: 1, rpc: 'https://eth.llamarpc.com' },
  'matic-mainnet': { chainId: 137, rpc: 'https://polygon-rpc.com' },
  'base-mainnet': { chainId: 8453, rpc: 'https://mainnet.base.org' },
  'arbitrum-mainnet': { chainId: 42161, rpc: 'https://arb1.arbitrum.io/rpc' },
  'optimism-mainnet': { chainId: 10, rpc: 'https://mainnet.optimism.io' }
};

const DEFAULT_CONTRACT = '0xddea51dd8649e0605770348ceb417c64c1b350c7';
const DEFAULT_CHAIN = 'cronos-mainnet';
const MAX_TOKENS = 30; // safety cap so one wallet can't stall the function

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
  const selector = '0xc87b56dd'; // tokenURI(uint256)
  const paddedId = BigInt(tokenId).toString(16).padStart(64, '0');
  const data = selector + paddedId;
  const result = await rpcCall(rpcUrl, contract, data);
  return decodeAbiString(result);
}

async function getMetadata(tokenUri) {
  if (tokenUri.startsWith('data:application/json;base64,')) {
    const json = Buffer.from(tokenUri.split(',')[1], 'base64').toString('utf8');
    return JSON.parse(json);
  }
  const url = ipfsToHttp(tokenUri);
  const res = await fetch(url);
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

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing ETHERSCAN_API_KEY. Set it in your Vercel project settings.' });
  }

  try {
    // 1. Pull NFT transfer history for this wallet + contract, work out current holdings.
    const txUrl = 'https://api.etherscan.io/v2/api?chainid=' + chainInfo.chainId +
      '&module=account&action=tokennfttx&contractaddress=' + encodeURIComponent(contract) +
      '&address=' + encodeURIComponent(address) + '&page=1&offset=1000&sort=asc&apikey=' + apiKey;

    const txRes = await fetch(txUrl);
    const txData = await txRes.json();

    if (txData.status !== '1' && txData.message !== 'No transactions found') {
      return res.status(502).json({ error: 'Etherscan API error: ' + (txData.result || txData.message) });
    }

    const owned = new Set();
    const wallet = address.toLowerCase();
    (txData.result || []).forEach(tx => {
      if (tx.to && tx.to.toLowerCase() === wallet) owned.add(tx.tokenID);
      if (tx.from && tx.from.toLowerCase() === wallet) owned.delete(tx.tokenID);
    });

    const tokenIds = Array.from(owned).slice(0, MAX_TOKENS);

    // 2. Read each owned token's metadata directly from the chain.
    const cards = await Promise.all(tokenIds.map(async (tokenId) => {
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
        return { id: contract + '-' + tokenId, name: 'NFT #' + tokenId, image: null, attributes: [] };
      }
    }));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ cards });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to load NFTs.' });
  }
}
