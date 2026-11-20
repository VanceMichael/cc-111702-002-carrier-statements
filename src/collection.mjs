import { resolveStatement, acceptStatement } from './fees.mjs';
import { validateVoucher, validateApplication, acceptVoucher, acceptApplication, reconcileVoucher } from './vouchers.mjs';
import { assessStatement } from './periods.mjs';

function targetOf(route, param) {
  return { method: route.method, path: route.path.replace(':month', param).replace(':id', encodeURIComponent(param)) };
}

// 来源明细暂时不可用或明确拒答属于资料缺口，不当作办理失败；断连、超时等传输故障仍向上抛出，整笔回滚。
async function tryFetch(source, route, param, request) {
  try {
    return { ok: true, data: await source.request(request, targetOf(route, param)) };
  } catch (error) {
    if (error.status) return { ok: false, kind: 'source-declined', detail: `来源以 ${error.status} 拒绝提供` };
    throw error;
  }
}

function markGap(state, gapKey, gap) { state.gaps[gapKey] = { ...gap, at: Math.max(gap.at ?? 0, Math.floor(Date.now() / 1000)) }; }

async function ensureVoucher(state, source, routes, request, voucherId, now) {
  const known = state.vouchers[voucherId];
  const gapKey = `adjustment:${voucherId}`;
  const outcome = await tryFetch(source, routes.adjustment, voucherId, request);
  if (!outcome.ok) {
    if (!known) markGap(state, gapKey, { kind: outcome.kind, ref: voucherId, detail: outcome.detail });
    return;
  }
  let voucher;
  try { voucher = validateVoucher(outcome.data); }
  catch (error) {
    if (!known) markGap(state, gapKey, { kind: 'unusable', ref: voucherId, detail: error.message });
    return;
  }
  if (voucher.id !== voucherId) {
    if (!known) markGap(state, gapKey, { kind: 'identity-mismatch', ref: voucherId, detail: '来源返回的凭据身份与引用不符' });
    return;
  }
  acceptVoucher(state, voucher, now());
  delete state.gaps[gapKey];
  for (const applicationId of voucher.applicationRefs) await ensureApplication(state, source, routes, request, applicationId, voucherId, now);
  reconcileVoucher(state, voucherId);
}

async function ensureApplication(state, source, routes, request, applicationId, voucherId, now) {
  const known = state.applications[applicationId];
  const gapKey = `application:${applicationId}`;
  const outcome = await tryFetch(source, routes.application, applicationId, request);
  if (!outcome.ok) {
    if (!known) markGap(state, gapKey, { kind: outcome.kind, ref: applicationId, detail: outcome.detail });
    return;
  }
  let application;
  try { application = validateApplication(outcome.data); }
  catch (error) {
    if (!known) markGap(state, gapKey, { kind: 'unusable', ref: applicationId, detail: error.message });
    return;
  }
  if (application.applicationId !== applicationId) {
    if (!known) markGap(state, gapKey, { kind: 'identity-mismatch', ref: applicationId, detail: '来源返回的应用身份与引用不符' });
    return;
  }
  if (application.voucher !== voucherId) throw new Error(`抵扣应用 ${applicationId} 不属于凭据 ${voucherId}`);
  acceptApplication(state, application, now());
  delete state.gaps[gapKey];
}

// 办理一次月份收件：结算清单 → 调整凭据 → 凭据逐笔抵扣应用 → 实际结算去向，全部在同一状态事务内完成。
export async function collectMonth(state, source, routes, input, now = () => Math.floor(Date.now() / 1000)) {
  const { month, ...request } = input;
  const statementData = resolveStatement(input, await source.request(request, targetOf(routes.statement, month)));
  assessStatement(state, statementData);
  acceptStatement(state, statementData, now());
  const voucherIds = new Set();
  for (const statement of Object.values(state.statements)) for (const ref of statement.adjustmentRefs) voucherIds.add(ref);
  for (const voucherId of voucherIds) await ensureVoucher(state, source, routes, request, voucherId, now);
  // 已不再被任何凭据引用的应用缺口随补件关闭；缺口始终只代表当前仍缺的依据。
  const referencedApplications = new Set(Object.values(state.vouchers).flatMap(voucher => voucher.applicationRefs));
  for (const gapKey of Object.keys(state.gaps)) {
    if (!gapKey.startsWith('application:')) continue;
    const ref = gapKey.slice('application:'.length);
    if (!referencedApplications.has(ref) && !state.applications[ref]) delete state.gaps[gapKey];
  }
  return state;
}
