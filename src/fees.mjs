// 费用职责：核对原始收费粒度，区分运单身份与费用行身份；原始账单只收件、不被抵扣覆盖。
export function prepare(state, input) {
  const month = input.month ?? '2026-01';
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式无效');
  state.requestedMonths[month] = true;
  return { month, authorization: input.authorization };
}

export function resolveStatement(request, data) {
  if (!data || typeof data !== 'object') throw new Error('收费资料不完整');
  if (!Array.isArray(data.lines) || data.month !== request.month) throw new Error('收费资料不属于请求账期');
  if (!data.statementId) throw new Error('账单身份缺失');
  const adjustmentRefs = Array.isArray(data.adjustmentRefs) ? data.adjustmentRefs : [];
  const identities = new Set(); const waybills = new Map();
  for (const line of data.lines) {
    if (!line.feeId || identities.has(line.feeId) || !line.waybill || !Number.isSafeInteger(line.amount) || line.amount < 0) throw new Error('原始收费行不合法');
    identities.add(line.feeId); waybills.set(line.waybill, (waybills.get(line.waybill) ?? 0) + line.amount);
  }
  for (const ref of adjustmentRefs) if (typeof ref !== 'string' || !ref) throw new Error('调整凭据引用不合法');
  if (new Set(adjustmentRefs).size !== adjustmentRefs.length) throw new Error('同一账单重复登记调整凭据');
  return { ...data, adjustmentRefs: [...adjustmentRefs], feeCount: identities.size, waybillCount: waybills.size };
}

function sameFees(left, right) {
  const a = Object.keys(left).sort(); const b = Object.keys(right).sort();
  if (a.length !== b.length || a.some((key, index) => key !== b[index])) return false;
  return a.every(key => left[key].waybill === right[key].waybill && left[key].amount === right[key].amount);
}

// 重收只补缺口：原件不可变，已登记的调整凭据引用不得移除，新引用并入而不是生成第二笔调整。
export function acceptStatement(state, data, receivedAt) {
  const fees = {};
  for (const line of data.lines) {
    if (fees[line.feeId]) throw new Error('同一账单重复收费身份');
    fees[line.feeId] = { feeId: line.feeId, waybill: line.waybill, amount: line.amount };
  }
  const known = state.statements[data.statementId];
  if (known) {
    if (known.month !== data.month) throw new Error('账单身份跨账期冲突');
    if (!sameFees(known.fees, fees)) throw new Error('账单原件与已收件内容不一致');
    for (const ref of known.adjustmentRefs) if (!data.adjustmentRefs.includes(ref)) throw new Error('重收不得移除已登记的调整凭据');
  }
  const adjustmentRefs = [...new Set([...(known?.adjustmentRefs ?? []), ...data.adjustmentRefs])];
  state.statements[data.statementId] = {
    statementId: data.statementId,
    month: data.month,
    fees,
    adjustmentRefs,
    receivedAt: known?.receivedAt ?? receivedAt,
  };
  return data.statementId;
}
