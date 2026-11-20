import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../src/fixture.mjs';
import { createProduct } from '../src/product.mjs';

const script = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
let clock = 1769900000;
async function withFixture(value, operation) {
  const fixture = await startFixture(structuredClone(value));
  try { await operation(fixture); } finally { await fixture.close(); }
}
async function makeProduct(fixture) { return createProduct({ sourceUrl: fixture.url, now: () => ++clock }); }
const find = (items, key, value) => items.find(item => item[key] === value);

test('跨期抵扣链路：清单→凭据→分次应用→结算去向，三期分别归集', async () => {
  await withFixture(script, async fixture => {
    const product = await makeProduct(fixture);
    await product.collect({ month: '2026-01' });
    await product.collect({ month: '2026-02' });
    await product.collect({ month: '2026-03' });
    const view = product.view();

    // 原始账单不被抵扣覆盖：一月运单口径仍是原始 1200。
    assert.equal(view.periods['2026-01'].amount, 1200);
    assert.deepEqual(view.periods['2026-01'].waybills, { W1: 1200 });
    assert.deepEqual(view.periods['2026-01'].vouchersIssued, []);

    // V1 一张凭据分两次抵扣两张结算单，二月只应用 100，三月应用 200。
    const v1 = find(view.vouchers, 'voucherId', 'V1');
    assert.equal(v1.applied, 300); assert.equal(v1.claimableBalance, 0);
    assert.deepEqual(v1.applications.map(a => a.statementId), ['S-FEB', 'S-MAR']);
    assert.equal(view.periods['2026-02'].appliedDeductions['S-FEB'], 280);
    assert.equal(view.periods['2026-03'].appliedDeductions['S-MAR'], 200);
    // 抵扣额不并入运费行：二月运费口径仍为原始 800。
    assert.equal(view.periods['2026-02'].amount, 800);

    // 沿费用行可追溯全部后续抵扣。
    const f1 = find(view.fees, 'feeId', 'F1');
    assert.deepEqual(f1.vouchers, ['V1', 'V3']);
    assert.equal(f1.verifiedDeducted, 300);
    assert.equal(f1.pendingVerification, false);

    // 申诉中的凭据只记录状态与已应用额，不裁决争议。
    const v2 = find(view.vouchers, 'voucherId', 'V2');
    assert.equal(v2.status, 'appealed'); assert.equal(v2.effect, 'appealed');
    assert.equal(v2.claimableBalance, 90);
  });
});

test('撤回未使用与使用后冲回对余额和旧账依据的影响不同', async () => {
  await withFixture(script, async fixture => {
    const product = await makeProduct(fixture);
    await product.collect({ month: '2026-02' });
    const view = product.view();
    const withdrawn = find(view.vouchers, 'voucherId', 'V3');
    const reversed = find(view.vouchers, 'voucherId', 'V4');

    // 撤回的未使用凭据：无可领余额，也从未进入任何结算。
    assert.equal(withdrawn.effect, 'withdrawn-unused');
    assert.equal(withdrawn.claimableBalance, 0);
    assert.equal(withdrawn.netApplied, 0);
    assert.deepEqual(withdrawn.applications, []);

    // 用过又冲回的凭据：净额归零、余额不恢复，但抵扣与冲回两笔依据都保留。
    assert.equal(reversed.effect, 'used-then-reversed');
    assert.equal(reversed.applied, 120); assert.equal(reversed.reversed, 120);
    assert.equal(reversed.netApplied, 0); assert.equal(reversed.claimableBalance, 0);
    assert.deepEqual(reversed.applications.map(a => a.kind), ['apply', 'reverse']);
    // 冲回后该结算单不再承担这笔抵扣。
    assert.equal(view.periods['2026-02'].appliedDeductions['S-FEB'], 280);
  });
});

test('源端只给部分明细时月份保持待核实，不按总额配平，其他月份照常完整', async () => {
  const partial = structuredClone(script);
  const ap2 = partial.routes.find(route => route.path === '/applications/AP2');
  ap2.responses = [{ status: 503, body: { error: '明细暂不可用' } }];
  await withFixture(partial, async fixture => {
    const product = await makeProduct(fixture);
    const jan = await product.collect({ month: '2026-01' });
    const feb = await product.collect({ month: '2026-02' });

    assert.equal(jan.periods['2026-01'].complete, true);
    assert.equal(feb.periods['2026-02'].complete, false);
    assert.deepEqual(feb.periods['2026-02'].incompleteReasons, [{ kind: 'application-missing', voucherId: 'V1', applicationId: 'AP2' }]);
    const gap = feb.pending.find(item => item.gapKey === 'application:AP2');
    assert.equal(gap.kind, 'source-declined');

    // 已收到的那部分应用照样入账，缺口不凭空生成抵扣。
    const v1 = find(feb.vouchers, 'voucherId', 'V1');
    assert.equal(v1.reliable, false);
    assert.equal(v1.applied, 100); assert.equal(v1.claimableBalance, 200);
    assert.equal(feb.periods['2026-02'].appliedDeductions['S-FEB'], 280);
    const f1 = find(feb.fees, 'feeId', 'F1');
    assert.equal(f1.pendingVerification, true);
  });
});

test('补件后补上原缺口而不是第二笔调整，月份转为完整', async () => {
  const partial = structuredClone(script);
  const ap2 = partial.routes.find(route => route.path === '/applications/AP2');
  ap2.responses = [
    { status: 503, body: { error: '明细暂不可用' } },
    { body: script.routes.find(route => route.path === '/applications/AP2').responses[0].body },
  ];
  await withFixture(partial, async fixture => {
    const product = await makeProduct(fixture);
    await product.collect({ month: '2026-02' });
    assert.equal(product.view().periods['2026-02'].complete, false);
    const after = await product.collect({ month: '2026-02' });

    assert.equal(after.periods['2026-02'].complete, true);
    assert.deepEqual(after.pending, []);
    const v1 = find(after.vouchers, 'voucherId', 'V1');
    assert.equal(v1.reliable, true); assert.equal(v1.applied, 300);
    assert.equal(v1.applications.length, 2);
    // 重收没有生成重复费用行或重复凭据。
    assert.equal(Object.keys(after.periods['2026-02'].waybills).length, 1);
    assert.equal(after.vouchers.length, 4);
  });
});

test('重复收件保持幂等，已收依据不产生第二笔', async () => {
  await withFixture(script, async fixture => {
    const product = await makeProduct(fixture);
    await product.collect({ month: '2026-02' });
    const before = product.view();
    const again = await product.collect({ month: '2026-02' });
    assert.deepEqual(again.vouchers.map(v => v.voucherId), before.vouchers.map(v => v.voucherId));
    assert.equal(again.vouchers.length, 4);
    assert.equal(again.fees.filter(f => f.statementId === 'S-FEB').length, 1);
  });
});

test('应用累计超过凭据原额被整笔拒绝且不提交中间状态', async () => {
  const bad = structuredClone(script);
  bad.routes.find(route => route.path === '/applications/AP1').responses[0].body.amount = 250;
  await withFixture(bad, async fixture => {
    const product = await makeProduct(fixture);
    const before = product.view();
    await assert.rejects(product.collect({ month: '2026-02' }), /超过调整凭据原额/);
    assert.deepEqual(product.view(), before);
  });
});

test('已撤回凭据若仍挂抵扣额被拒绝；冲回超过已抵扣也被拒绝', async () => {
  const withdrawn = structuredClone(script);
  withdrawn.routes.find(route => route.path === '/adjustments/V3').responses[0].body.applicationRefs = ['AP6'];
  withdrawn.routes.push({ method: 'GET', path: '/applications/AP6', responses: [{ body: { applicationId: 'AP6', voucher: 'V3', statementId: 'S-FEB', amount: 80, kind: 'apply', appliedAt: 1770768000 } }] });
  await withFixture(withdrawn, async fixture => {
    const product = await makeProduct(fixture);
    await assert.rejects(product.collect({ month: '2026-02' }), /已撤回凭据/);
  });

  const overReverse = structuredClone(script);
  overReverse.routes.find(route => route.path === '/applications/AP5').responses[0].body.amount = 200;
  await withFixture(overReverse, async fixture => {
    const product = await makeProduct(fixture);
    await assert.rejects(product.collect({ month: '2026-02' }), /冲回/);
  });
});

test('凭据原件在重收中被改写时拒绝，保护一月原始账单依据', async () => {
  const tampered = structuredClone(script);
  const statement = tampered.routes.find(route => route.path === '/statements/2026-02');
  statement.responses = [
    { body: structuredClone(statement.responses[0].body) },
    { body: { ...structuredClone(statement.responses[0].body), lines: [{ feeId: 'F3', waybill: 'W2', amount: 1 }], adjustmentRefs: ['V1', 'V2', 'V3', 'V4'] } },
  ];
  await withFixture(tampered, async fixture => {
    const product = await makeProduct(fixture);
    await product.collect({ month: '2026-02' });
    await assert.rejects(product.collect({ month: '2026-02' }), /原件与已收件内容不一致/);
    assert.equal(product.view().periods['2026-02'].amount, 800);
  });
});

test('凭据来源结构不合法登记为缺口，其他已明确账单继续收件', async () => {
  const broken = structuredClone(script);
  broken.routes.find(route => route.path === '/adjustments/V2').responses = [{ body: { id: 'V2' } }];
  await withFixture(broken, async fixture => {
    const product = await makeProduct(fixture);
    const feb = await product.collect({ month: '2026-02' });
    assert.equal(feb.periods['2026-02'].complete, false);
    assert.ok(feb.pending.some(item => item.gapKey === 'adjustment:V2' && item.kind === 'unusable'));
    const v1 = find(feb.vouchers, 'voucherId', 'V1');
    assert.equal(v1.voucherId, 'V1');
  });
});

test('会计视角：证据时间线与月份收件依据都可查，三期不混', async () => {
  await withFixture(script, async fixture => {
    const product = await makeProduct(fixture);
    await product.collect({ month: '2026-01' });
    await product.collect({ month: '2026-02' });
    await product.collect({ month: '2026-03' });
    const view = product.view();
    const febEvidence = view.periods['2026-02'].evidence.map(item => item.kind);
    assert.deepEqual(febEvidence, ['statement', 'voucher', 'application', 'voucher', 'application', 'voucher', 'voucher', 'application', 'application']);    const timeline = view.evidence;
    assert.deepEqual([...new Set(timeline.map(item => item.kind))], ['statement', 'voucher', 'application']);
    for (let i = 1; i < timeline.length; i++) assert.ok(timeline[i].at >= timeline[i - 1].at);
    // 三月只承担 V1 的第二笔应用，不重复登记 V1 凭据本身。
    assert.deepEqual(view.periods['2026-03'].vouchersIssued, []);
    assert.deepEqual(view.periods['2026-03'].applicationsSettled, ['AP2']);
  });
});

test('抵扣链路状态持久化重开后保持，含待核实缺口', async () => {
  const partial = structuredClone(script);
  partial.routes.find(route => route.path === '/applications/AP2').responses = [{ status: 503, body: { error: '明细暂不可用' } }];
  const directory = await mkdtemp(join(tmpdir(), 'adjustment-'));
  try {
    const statePath = join(directory, 'state.json');
    await withFixture(partial, async fixture => {
      const first = await makeProductWith(fixture, statePath);
      await first.collect({ month: '2026-02' });
      const reopened = await makeProductWith(fixture, statePath);
      const view = reopened.view();
      assert.equal(view.periods['2026-02'].complete, false);
      assert.ok(view.pending.some(item => item.gapKey === 'application:AP2'));
      assert.equal(find(view.vouchers, 'voucherId', 'V4').effect, 'used-then-reversed');
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function makeProductWith(fixture, statePath) {
  return createProduct({ sourceUrl: fixture.url, statePath, now: () => ++clock });
}
