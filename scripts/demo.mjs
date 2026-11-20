import { readFile } from 'node:fs/promises';
import { startFixture } from '../src/fixture.mjs';
import { createProduct } from '../src/product.mjs';
const fixture = await startFixture(JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8')));
try {
  const product = await createProduct({ sourceUrl: fixture.url });
  console.log('一月：领取原始费用清单，运单口径只含原始费用');
  console.log(JSON.stringify((await product.collect({ month: '2026-01' })).periods['2026-01'], null, 2));
  console.log('二月：抵扣一月错收费用，凭据开立期与结算应用期分开登记');
  const feb = await product.collect({ month: '2026-02' });
  console.log('二月完整性', feb.periods['2026-02'].complete, '本期已落结算单的抵扣', feb.periods['2026-02'].appliedDeductions);
  console.log('三月：同一张 V1 凭据的第二笔抵扣落到三月结算单');
  const mar = await product.collect({ month: '2026-03' });
  console.log('三月结算应用', mar.periods['2026-03'].appliedDeductions, '沿 F1 追溯', JSON.stringify(mar.fees.find(fee => fee.feeId === 'F1'), null, 2));
  console.log('来源实际请求'); console.log(JSON.stringify(fixture.calls.map(call => ({ method: call.method, path: call.path, authenticated: call.authenticated })), null, 2));
} finally { await fixture.close(); }
