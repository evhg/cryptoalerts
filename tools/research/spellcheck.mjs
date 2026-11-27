const get=async u=>{const r=await fetch(u,{signal:AbortSignal.timeout(40000)});const t=await r.text();try{return JSON.parse(t)}catch{return {error:t.slice(0,200)}}}
const s=await get('https://vote.sky.money/api/executive/0xCFFa0aeA62794b883c20F2463ECdB0E20099106B?network=mainnet')
const bkk=t=>t?new Date(new Date(t).getTime()+7*3600e3).toISOString().replace('T',' ').slice(0,16)+' Bangkok':null
const d=s.spellData||{}
console.log('SFF spell: support',d.skySupport?(Number(BigInt(d.skySupport)/10n**18n)/1e6).toFixed(1)+'M SKY':s.error,'| scheduled',d.hasBeenScheduled,'| eta',bkk(d.eta),'| nextCast',bkk(d.nextCastTime),'| cast',d.hasBeenCast)
const l=await get('https://vote.sky.money/api/executive?network=mainnet&start=0&limit=3&sortBy=date')
if(Array.isArray(l))for(const e of l)console.log(' ',e.address.slice(0,10),e.title.slice(0,50),'| support',(Number(e.spellData.skySupport.split('.')[0])/1e6).toFixed(1)+'M','| active',e.active)
// On-chain truth: the proposal passes when its approvals exceed those of the chief's current "hat".
{
  const RPC='https://mainnet.gateway.tenderly.co', CHIEF='0x929d9A1435662357F54AdcF64DcEE4d6b867a6f9', SPELL='0xCFFa0aeA62794b883c20F2463ECdB0E20099106B'
  const call=async(to,data)=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']})});return (await r.json()).result}
  const hat='0x'+(await call(CHIEF,'0xfe95a5ce')).slice(26)
  const ap=async a=>Number(BigInt(await call(CHIEF,'0x5d0341ba'+a.slice(2).toLowerCase().padStart(64,'0')))/10n**18n)/1e6
  const [h,s]=[await ap(hat),await ap(SPELL)]
  console.log('ON-CHAIN: hat',hat.slice(0,10),'approvals',h.toFixed(1)+'M | SFF spell',s.toFixed(1)+'M |',hat.toLowerCase()===SPELL.toLowerCase()?'SFF SPELL IS THE HAT (passed)':'needs '+(h-s).toFixed(1)+'M more to pass')
}
