const RPC='https://mainnet.gateway.tenderly.co'
const rpc=async(m,p)=>{for(let i=0;i<6;i++){try{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();if(j.result!==undefined)return j.result}catch{} await new Promise(r=>setTimeout(r,700))}}
const H='0xe0bba8305d99e7307658278e02b94df870dfd46c328f15fcd270c01ab9735ff7'
const tx=await rpc('eth_getTransactionByHash',[H]), rc=await rpc('eth_getTransactionReceipt',[H])
const bn=parseInt(tx.blockNumber,16)
const blk=await rpc('eth_getBlockByNumber',[tx.blockNumber,true])
const g=x=>(Number(BigInt(x))/1e9).toFixed(3)
console.log('block',bn,'builder',Buffer.from(blk.extraData.slice(2),'hex').toString().replace(/[^\x20-\x7e]/g,''),'miner',blk.miner,'txs',blk.transactions.length,'baseFee',g(blk.baseFeePerGas),'gwei')
console.log('repay tx idx',parseInt(tx.transactionIndex,16),'from',tx.from,'to',tx.to,'sel',tx.input.slice(0,10),'prio',g(BigInt(tx.maxPriorityFeePerGas??0)),'type',tx.type,'gasUsed',parseInt(rc.gasUsed,16))
const ST='0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'
const logs=await rpc('eth_getLogs',[{address:ST,fromBlock:'0x'+(bn-1).toString(16),toBlock:'0x'+(bn+3).toString(16)}])
const W='0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db',D='0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7'
for(const l of logs){ if(l.topics[0]!==W&&l.topics[0]!==D) continue
  const t=await rpc('eth_getTransactionByHash',[l.transactionHash]); const r=await rpc('eth_getTransactionReceipt',[l.transactionHash])
  const assets=Number(BigInt('0x'+l.data.slice(2,66)))/1e18
  console.log(l.topics[0]===W?'WITHDRAW':'DEPOSIT ',parseInt(l.blockNumber,16),'idx',parseInt(l.transactionIndex,16),assets.toFixed(2),'tx',l.transactionHash,'from',t.from,'to',t.to,'prio',g(BigInt(t.maxPriorityFeePerGas??0)),'gasUsed',parseInt(r.gasUsed,16))
}
// txs around the repayment in the block
const i0=parseInt(tx.transactionIndex,16)
for(const t of blk.transactions.slice(Math.max(0,i0-1),i0+4)) console.log(' idx',parseInt(t.transactionIndex,16),t.hash.slice(0,12),'from',t.from.slice(0,12),'to',(t.to||'create').slice(0,12),'sel',t.input.slice(0,10),'prio',g(BigInt(t.maxPriorityFeePerGas??t.gasPrice)),'value',(Number(BigInt(t.value))/1e18).toFixed(5))
// who repaid: which urn
console.log('logs in repay tx:',rc.logs.length, [...new Set(rc.logs.map(l=>l.address.slice(0,10)))].join(','))
for(let n=bn-2;n<=bn+2;n++){const b=await rpc('eth_getBlockByNumber',['0x'+n.toString(16),false]);console.log(n,Buffer.from(b.extraData.slice(2),'hex').toString().replace(/[^\x20-\x7e]/g,''),new Date((parseInt(b.timestamp,16)+7*3600)*1000).toISOString().slice(11,19),'BKK')}
