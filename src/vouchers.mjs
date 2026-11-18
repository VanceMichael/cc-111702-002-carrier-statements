export function accept(state, request, data) {
  if (data.month !== request.month || !data.statementId || !Array.isArray(data.lines)) throw new Error('账期或账单身份不符');
  const fees = {};
  for (const line of data.lines) {
    if (!line.feeId || !Number.isSafeInteger(line.amount)) throw new Error('费用行无效');
    if (fees[line.feeId]) throw new Error('同一账单重复收费身份');
    fees[line.feeId] = { ...line };
  }
  state.statements[data.statementId] = { month: data.month, fees, received: true };
  return data.statementId;
}
