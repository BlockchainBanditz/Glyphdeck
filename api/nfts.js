// Vercel serverless function: /api/nfts
// Uses Covalent's GoldRush API (supports Cronos) — key stays server-side.
// Set GOLDRUSH_API_KEY in your Vercel project's Environment Variables.

const CHAIN_SLUGS = new Set([
  'cronos-mainnet', 'eth-mainnet', 'matic-mainnet', 'base-mainnet', 'optimism-mainnet', 'arbitrum-mainnet'
]);

// Locked to your collection by default. A caller-supplied contract is still
// allowed (useful for testing other collections), but if none is given,
// this is what gets used.
const DEFAULT_CONTRACT = '0xddea51dd8649e0605770348ceb417c64c1b350c7';
const DEFAULT_CHAIN = 'cronos-mainnet';

export default async function handler(req, res) {
  const { address, chain = DEFAULT_CHAIN, contract = DEFAULT_CONTRACT } = req.query;

  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'Missing "address" query parameter.' });
  }
  if (!CHAIN_SLUGS.has(chain)) {
    return res.status(400).json({ error: 'Unsupported chain: ' + chain });
  }

  const apiKey = process.env.GOLDRUSH_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing GOLDRUSH_API_KEY. Set it in your Vercel project settings.' });
  }

  const url = 'https://api.covalenthq.com/v1/' + encodeURIComponent(chain) +
    '/address/' + encodeURIComponent(address) + '/balances_nft/?no-spam=true';

  try {
    const grRes = await fetch(url, { headers: { Authorization: 'Bearer ' + apiKey } });
    const data = await grRes.json();
    if (!grRes.ok || data.error) {
      return res.status(grRes.status || 500).json({ error: data.error_message || ('GoldRush API error (' + grRes.status + ').') });
    }

    const items = (data.data && data.data.items) || [];
    const wantContract = contract ? String(contract).toLowerCase() : null;

    const cards = [];
    items.forEach(collection => {
      if (wantContract && collection.contract_address && collection.contract_address.toLowerCase() !== wantContract) return;
      (collection.nft_data || []).forEach(nft => {
        const ext = nft.external_data || {};
        cards.push({
          id: collection.contract_address + '-' + nft.token_id,
          name: ext.name || (collection.contract_name || 'NFT') + ' #' + nft.token_id,
          image: ext.image || ext.image_512 || ext.image_256 || null,
          attributes: ext.attributes || []
        });
      });
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ cards });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch NFTs from GoldRush.' });
  }
}
