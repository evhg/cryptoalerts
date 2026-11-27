import json, collections
d = json.load(open('/tmp/claude-0/-home-user-cryptoalerts/f3bc1415-094c-5ea0-a057-91e8b18caa13/scratchpad/census/census.json'))
W, S = d['withdrawals'], d['sources']
SCARCE = 26412000  # about 14 Nov: utilization pinned at 100%
B = {'0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97': 'titan', '0x396343362be2a4da1ce0c1c210945346fb82aa49': 'quasar', '0xdadb0d80178819f2319190d340ce9a924f783711': 'buildernet',
     '0xfb74767c1ce1aada0a0e114441173b57f8c1571b': 'eureka', '0x85c2e985e5f3e9ba0b1dd9d2a5c1b0c7d3e6c4d1': 'bombora'}
src = collections.defaultdict(list)
for s in S:
    src[s['block']].append(s)
blocks = collections.OrderedDict()
for w in W:
    if w['block'] < SCARCE:
        continue
    blocks.setdefault(w['block'], []).append(w)
rows = []
for b, ws in blocks.items():
    ss = sorted(src.get(b, []), key=lambda s: s['txi'])
    ws = sorted(ws, key=lambda w: w['txi'])
    first_src = ss[0]['txi'] if ss else None
    gap = (ws[0]['txi'] - first_src) if first_src is not None else None
    builder = B.get(ws[0]['miner'], 'other')
    rows.append({'block': b, 'day': ws[0]['day'], 'builder': builder, 'amt': sum(w['amt'] for w in ws), 'takers': len(ws), 'src_in_block': first_src is not None, 'gap': gap,
                 'kinds': '/'.join(sorted(set(w['kind'].split(' ')[0] for w in ws))), 'pay_pct': 100 * sum(w['payEth'] for w in ws) * 1700 / max(sum(w['amt'] for w in ws), 1)})
print('scarcity-era blocks with a withdrawal of 100 USDS or more:', len(rows), 'from block', SCARCE, 'to', d['head'])
tot = sum(r['amt'] for r in rows)
print('total withdrawn', round(tot))
by = collections.defaultdict(lambda: [0, 0.0])
for r in rows:
    by[r['builder']][0] += 1
    by[r['builder']][1] += r['amt']
for k, v in sorted(by.items(), key=lambda kv: -kv[1][1]):
    print(f"  {k:10s} blocks {v[0]:3d} amount {v[1]:>12,.0f} ({v[1] / tot * 100:.0f}%)")
adj = [r for r in rows if r['gap'] is not None and r['gap'] <= 1]
later = [r for r in rows if r['gap'] is not None and r['gap'] > 1]
nosrc = [r for r in rows if r['gap'] is None]
f = lambda xs: f"{len(xs)} blocks, {sum(x['amt'] for x in xs):,.0f} USDS"
print('taker directly behind the freeing transaction (gap 0 or 1):', f(adj))
print('taker later in the same block (gap > 1):', f(later))
print('freeing transaction in an earlier block or not identified:', f(nosrc))
print('\nQuasar blocks:')
for r in rows:
    if r['builder'] == 'quasar':
        print(f"  {r['day']} block {r['block']} amount {r['amt']:>11,.0f} takers {r['takers']} kinds {r['kinds']} gap {r['gap']} paid {r['pay_pct']:.2f}%")
days = sorted(set(r['day'] for r in rows))
print('\ndays covered', days[0], '->', days[-1], '(', len(days), 'days with activity )')
