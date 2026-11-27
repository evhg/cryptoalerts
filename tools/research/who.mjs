const RPC='https://ethereum-rpc.publicnode.com'
const rpc=async(m,p)=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return (await r.json()).result}
const [a,b]=process.argv.slice(2).map(Number)
for(let n=a;n<=b;n++){const blk=await rpc('eth_getBlockByNumber',['0x'+n.toString(16),false]);console.log(n,Buffer.from(blk.extraData.slice(2),'hex').toString().replace(/[^\x20-\x7e]/g,'.'),blk.miner.slice(0,10),'txs',blk.transactions.length)}
