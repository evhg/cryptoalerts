const RPC='https://ethereum-rpc.publicnode.com'
const rpc=async(m,p)=>{for(let i=0;i<5;i++){try{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();if(j.result)return j.result}catch{} await new Promise(r=>setTimeout(r,500))}}
const head=parseInt(await rpc('eth_blockNumber',[]),16)
const N=600, counts={}, buckets=[{},{},{},{},{},{}]
const nums=Array.from({length:N},(_,i)=>head-N+1+i)
for(let i=0;i<nums.length;i+=40){
  const res=await Promise.all(nums.slice(i,i+40).map(n=>rpc('eth_getBlockByNumber',['0x'+n.toString(16),false])))
  for(const b of res){if(!b)continue;const n=parseInt(b.number,16);let x=Buffer.from(b.extraData.slice(2),'hex').toString().replace(/[^\x20-\x7e]/g,'').toLowerCase();const k=x.includes('titan')?'titan':x.includes('quasar')?'quasar':x.includes('buildernet')?'buildernet':x.includes('eureka')?'eureka':x.includes('bombora')?'bombora':'other';const bi=Math.floor((n-(head-N+1))/100);buckets[bi][k]=(buckets[bi][k]||0)+1; if(k==='quasar')counts.last=n}
}
console.log('head',head,'last Quasar block',counts.last,'(',head-(counts.last??0),'blocks ago )')
buckets.forEach((b,i)=>console.log('blocks',head-N+1+i*100,'-',head-N+100+i*100,JSON.stringify(b)))
