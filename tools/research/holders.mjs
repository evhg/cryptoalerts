const RPC='https://ethereum-rpc.publicnode.com'
const rpc=async(method,params)=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();return j.result}
const j=await (await fetch('https://api.ethplorer.io/getTopTokenHolders/0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9?apiKey=freekey&limit=100')).json()
const nav=1.09425
let cum=0
for(const [i,h] of j.holders.entries()){
  const usd=Number(h.rawBalance)/1e18*nav; cum+=h.share
  if(i<25){
    const code=await rpc('eth_getCode',[h.address,'latest'])
    let kind=code==='0x'?'wallet':('contract '+((code.length-2)/2)+'b')
    if(code!=='0x'){ const th=await rpc('eth_call',[{to:h.address,data:'0xe75235b8'},'latest']).catch(()=>null); if(th&&th!=='0x'&&th.length===66&&BigInt(th)<20n&&BigInt(th)>0n){const ow=await rpc('eth_call',[{to:h.address,data:'0xa0e67e2b'},'latest']);kind='Safe '+BigInt(th)+'-of-'+parseInt(ow.slice(66,130),16)} }
    const n=code==='0x'?parseInt(await rpc('eth_getTransactionCount',[h.address,'latest']),16):''
    console.log(String(i+1).padStart(2),h.address,(usd/1e6).toFixed(2).padStart(6)+'M',(h.share+'%').padStart(7),'cum',cum.toFixed(1)+'%',kind,n?('txs '+n):'')
  }
}
console.log('holders returned',j.holders.length,'cum share',cum.toFixed(1))
const sizes=j.holders.map(h=>Number(h.rawBalance)/1e18*nav)
console.log('>=1M:',sizes.filter(x=>x>=1e6).length,'sum',(sizes.filter(x=>x>=1e6).reduce((a,b)=>a+b,0)/1e6).toFixed(1)+'M')
