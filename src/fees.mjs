export function prepare(state, input) {
  const month = input.month ?? '2026-01';
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式无效');
  state.requestedMonths[month] = true;
  return { month };
}

export function resolve(state, request, data) {
  if (!Array.isArray(data.lines) || data.month !== request.month) throw new Error('收费资料不属于请求账期');
  const identities = new Set(); const waybills = new Map();
  for (const line of data.lines) {
    if (!line.feeId || identities.has(line.feeId) || !line.waybill || !Number.isSafeInteger(line.amount) || line.amount < 0) throw new Error('原始收费行不合法');
    identities.add(line.feeId); waybills.set(line.waybill, (waybills.get(line.waybill) ?? 0) + line.amount);
  }
  return { ...data, feeCount: identities.size, waybillCount: waybills.size };
}
