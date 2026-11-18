export function present(state) {
  const months = {};
  for (const [id, statement] of Object.entries(state.statements)) {
    const month = months[statement.month] ??= { statements: [], amount: 0, waybills: {} };
    month.statements.push(id);
    for (const fee of Object.values(statement.fees)) { month.amount += fee.amount; month.waybills[fee.waybill] = (month.waybills[fee.waybill] ?? 0) + fee.amount; }
  }
  return { months };
}

export function assess(state, request, data) {
  const existing = state.statements[data.statementId];
  if (existing && existing.month !== data.month) throw new Error('账单身份跨账期冲突');
  const amount = data.lines.reduce((sum,item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(amount)) throw new Error('账单总额超出准确范围');
  const monthStatements = Object.entries(state.statements).filter(([id,item]) => id !== data.statementId && item.month === data.month);
  for (const [,statement] of monthStatements) for (const line of data.lines) if (statement.fees[line.feeId]) throw new Error('同账期收费已在其他账单收件');
  return { month: request.month, amount, feeCount: data.feeCount };
}
