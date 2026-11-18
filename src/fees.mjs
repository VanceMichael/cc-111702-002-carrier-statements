export function prepare(state, input) {
  const month = input.month ?? '2026-01';
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式无效');
  state.requestedMonths[month] = true;
  return { month };
}
