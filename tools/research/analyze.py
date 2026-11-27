import json, collections, datetime
d=json.load(open('census.json')); W=d['withdrawals']; S=d['sources']
ETH=1700
SCARCE=26412000  # ~Nov 14: utilization pinned at 100%
def short(k): return {'self (repay/deposit + withdraw in one tx)':'self','arb (bought stUSDS in the same tx)':'arb','holder (redeemed own shares)':'holder'}[k]
print('period: block',d['from'],'->',d['head'])
print('\n== per day (Bangkok date): withdrawals >=100 USDS')
days=collections.OrderedDict()
for w in W:
    x=days.setdefault(w['day'],{'n':0,'amt':0,'ent':set(),'arb':set(),'holder':set(),'self':set(),'arbAmt':0,'holderAmt':0,'selfAmt':0})
    k=short(w['kind']); x['n']+=1; x['amt']+=w['amt']; x['ent'].add(w['entity']); x[k].add(w['entity']); x[k+'Amt']+=w['amt']
first={}
for w in W: first.setdefault(w['entity'],w['day'])
for day,x in days.items():
    new=[e for e in x['ent'] if first[e]==day]
    print(day, f"txs {x['n']:3d} vol {x['amt']:>11,.0f} | entities {len(x['ent']):2d} (new {len(new)}) | arb {len(x['arb'])} bots {x['arbAmt']:>10,.0f} | holders {len(x['holder'])} {x['holderAmt']:>10,.0f} | self {len(x['self'])} {x['selfAmt']:>10,.0f}")
print('\n== scarcity era only (since ~Nov 14), by entity')
E=collections.defaultdict(lambda:{'n':0,'amt':0,'kinds':collections.Counter(),'days':set(),'pay':0,'paid_n':0,'lag0':0,'lag1':0,'lagN':0,'from':set(),'last':''})
for w in W:
    if w['block']<SCARCE: continue
    e=E[w['entity']]; e['n']+=1; e['amt']+=w['amt']; e['kinds'][short(w['kind'])]+=1; e['days'].add(w['day']); e['from'].add(w['from']); e['last']=w['day']
    e['pay']+=w['payEth']*ETH; 
    if w['lag']==0: e['lag0']+=1
    elif w['lag']==1: e['lag1']+=1
    else: e['lagN']+=1
rows=sorted(E.items(), key=lambda kv:-kv[1]['amt'])
for ent,e in rows:
    print(f"{ent} n {e['n']:3d} vol {e['amt']:>11,.0f} kinds {dict(e['kinds'])} senders {len(e['from'])} days {len(e['days'])} first {first[ent]} last {e['last']} | same-block {e['lag0']} next-block {e['lag1']} later/none {e['lagN']} | paid builders ${e['pay']:,.0f} = {e['pay']/e['amt']*100:.2f}% of volume")
sc=[w for w in W if w['block']>=SCARCE]
tot=sum(w['amt'] for w in sc)
for k in ('arb','holder','self'):
    xs=[w for w in sc if short(w['kind'])==k]
    print(k, 'txs',len(xs),'vol',round(sum(w['amt'] for w in xs)), f"{sum(w['amt'] for w in xs)/tot*100:.1f}%", 'entities',len(set(w['entity'] for w in xs)))
print('\n== arb + racing holders: distinct entities active per day, and cumulative')
cum=set()
for day,x in days.items():
    if day<'2026-11-14': continue
    racers=set(w['entity'] for w in W if w['day']==day and short(w['kind'])!='self' and (w['lag'] in (0,1)))
    arbs=set(w['entity'] for w in W if w['day']==day and short(w['kind'])=='arb')
    cum|=racers|arbs
    print(day,'fast takers',len(racers),'arb bots',len(arbs),'cumulative distinct',len(cum))
print('\n== payments by arb txs (traced), % of USDS withdrawn')
for w in sc:
    if short(w['kind'])=='arb' and w['traced']:
        print(w['day'], w['block'], f"{w['amt']:>10,.0f}", w['entity'][:12], 'lag',w['lag'], f"paid ${w['payEth']*ETH:>8,.0f} = {w['payEth']*ETH/w['amt']*100:5.2f}%")
print('\n== holders racing (lag 0/1), payments')
for w in sc:
    if short(w['kind'])=='holder' and w['lag'] in (0,1):
        print(w['day'], w['block'], f"{w['amt']:>10,.0f}", w['entity'][:12], 'lag',w['lag'], w['srcKind'], f"paid ${w['payEth']*ETH:>8,.2f} = {w['payEth']*ETH/w['amt']*100:5.3f}%", 'to', w['to'][:10], w['sel'])
