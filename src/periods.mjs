export function present(state) {
  const months = {};
  for (const [id, statement] of Object.entries(state.statements)) {
    const month = months[statement.month] ??= { statements: [], amount: 0, waybills: {} };
    month.statements.push(id);
    for (const fee of Object.values(statement.fees)) { month.amount += fee.amount; month.waybills[fee.waybill] = (month.waybills[fee.waybill] ?? 0) + fee.amount; }
  }
  return { months };
}
