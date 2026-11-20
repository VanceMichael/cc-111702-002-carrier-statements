// 凭据职责：接纳调整凭据与逐笔抵扣应用，核对凭据分次抵扣的去向；只关联收件，不裁决争议费用是否合理。
export const VOUCHER_STATUS = Object.freeze(['issued', 'appealed', 'withdrawn', 'reversed']);
export const APPLICATION_KIND = Object.freeze(['apply', 'reverse']);

function whole(value) { return Number.isSafeInteger(value) && value > 0; }

export function validateVoucher(data) {
  if (!data || typeof data !== 'object') throw new Error('调整凭据不完整');
  if (!data.id || typeof data.id !== 'string') throw new Error('调整凭据身份缺失');
  if (!whole(data.amount)) throw new Error('调整凭据原额不合法');
  if (!data.feeId || typeof data.feeId !== 'string') throw new Error('调整凭据缺少费用行归属');
  if (!VOUCHER_STATUS.includes(data.status)) throw new Error('调整凭据状态不受支持');
  if (!Number.isSafeInteger(data.issuedAt) || data.issuedAt <= 0) throw new Error('凭据开立期不合法');
  if (!Array.isArray(data.applicationRefs)) throw new Error('调整凭据缺少应用明细');
  for (const ref of data.applicationRefs) if (typeof ref !== 'string' || !ref) throw new Error('抵扣应用引用不合法');
  if (new Set(data.applicationRefs).size !== data.applicationRefs.length) throw new Error('同一凭据重复登记抵扣应用');
  return { id: data.id, amount: data.amount, feeId: data.feeId, status: data.status, issuedAt: data.issuedAt, applicationRefs: [...data.applicationRefs] };
}

export function validateApplication(data) {
  if (!data || typeof data !== 'object') throw new Error('抵扣应用不完整');
  if (!data.applicationId || typeof data.applicationId !== 'string') throw new Error('抵扣应用身份缺失');
  if (!data.voucher || typeof data.voucher !== 'string') throw new Error('抵扣应用缺少凭据归属');
  if (!data.statementId || typeof data.statementId !== 'string') throw new Error('抵扣应用缺少结算单去向');
  if (!whole(data.amount)) throw new Error('抵扣应用金额不合法');
  if (!APPLICATION_KIND.includes(data.kind)) throw new Error('抵扣应用类型不受支持');
  if (!Number.isSafeInteger(data.appliedAt) || data.appliedAt <= 0) throw new Error('结算应用期不合法');
  return { applicationId: data.applicationId, voucher: data.voucher, statementId: data.statementId, amount: data.amount, kind: data.kind, appliedAt: data.appliedAt };
}

export function acceptVoucher(state, voucher, receivedAt) {
  const known = state.vouchers[voucher.id];
  if (known) {
    // 同一凭据重收必须指向同一原件与同一费用行；状态与应用明细的变化单独核对，避免静默改写历史。
    if (known.amount !== voucher.amount || known.feeId !== voucher.feeId || known.issuedAt !== voucher.issuedAt) throw new Error('调整凭据原件与已收件内容不一致');
    if (known.status !== voucher.status) throw new Error('调整凭据状态发生变化，需按撤回或冲回凭据重新收件');
    for (const ref of known.applicationRefs) if (!voucher.applicationRefs.includes(ref)) throw new Error('重收不得移除已登记的抵扣应用');
  }
  state.vouchers[voucher.id] = { ...voucher, applicationRefs: [...new Set([...(known?.applicationRefs ?? []), ...voucher.applicationRefs])], receivedAt: known?.receivedAt ?? receivedAt };
}

export function acceptApplication(state, application, receivedAt) {
  const known = state.applications[application.applicationId];
  if (known) {
    for (const field of ['voucher', 'statementId', 'amount', 'kind', 'appliedAt']) {
      if (known[field] !== application[field]) throw new Error('抵扣应用与已收件内容不一致');
    }
  }
  state.applications[application.applicationId] = { ...application, receivedAt: known?.receivedAt ?? receivedAt };
}

// 已收齐应用明细的凭据才做总额核对；明细未到齐时保持待核实，绝不按凭据总额倒推配平。
export function reconcileVoucher(state, voucherId) {
  const voucher = state.vouchers[voucherId];
  if (!voucher || voucher.applicationRefs.some(ref => !state.applications[ref])) return;
  let applied = 0; let reversed = 0; const settled = new Map();
  for (const ref of voucher.applicationRefs) {
    const application = state.applications[ref];
    if (application.voucher !== voucherId) throw new Error('抵扣应用与凭据归属不符');
    if (application.kind === 'apply') applied += application.amount;
    else reversed += application.amount;
    const entry = settled.get(application.statementId) ?? { apply: 0, reverse: 0 };
    entry[application.kind] += application.amount;
    settled.set(application.statementId, entry);
  }
  if (applied > voucher.amount) throw new Error('抵扣应用累计超过调整凭据原额');
  if (reversed > applied) throw new Error('冲回应用超过该凭据已抵扣金额');
  for (const [statementId, entry] of settled) {
    if (entry.reverse > entry.apply) throw new Error(`凭据 ${voucherId} 对结算单 ${statementId} 的冲回超过其抵扣`);
  }
  if (voucher.status === 'withdrawn' && applied - reversed !== 0) throw new Error('已撤回凭据不得保留已使用抵扣额');
}
