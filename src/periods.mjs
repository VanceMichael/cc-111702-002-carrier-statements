// 账期职责：防同一期跨单重复费用、决定月度完整性与收件口径；费用发生期、凭据开立期、结算应用期分别可查。
export function assessStatement(state, data) {
  const existing = state.statements[data.statementId];
  if (existing && existing.month !== data.month) throw new Error('账单身份跨账期冲突');
  const amount = data.lines.reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(amount)) throw new Error('账单总额超出准确范围');
  const monthStatements = Object.entries(state.statements).filter(([id, item]) => id !== data.statementId && item.month === data.month);
  for (const [, statement] of monthStatements) for (const line of data.lines) if (statement.fees[line.feeId]) throw new Error('同账期收费已在其他账单收件');
  return { month: data.month, amount, feeCount: data.feeCount };
}

function epochMonth(seconds) {
  const iso = new Date(seconds * 1000).toISOString();
  return iso.slice(0, 7);
}

function voucherTotals(voucher, state) {
  let applied = 0; let reversed = 0;
  const applications = [];
  for (const ref of voucher.applicationRefs) {
    const application = state.applications[ref];
    if (!application) continue;
    applications.push(application);
    if (application.kind === 'apply') applied += application.amount;
    else reversed += application.amount;
  }
  return { applied, reversed, netApplied: applied - reversed, applications };
}

function voucherEffect(voucher, totals) {
  if (voucher.status === 'withdrawn') return 'withdrawn-unused';
  if (voucher.status === 'reversed') return 'used-then-reversed';
  if (voucher.status === 'appealed') return 'appealed';
  return totals.netApplied > 0 ? 'partially-applied' : 'issued-unused';
}

function reliableVoucher(voucher, state) {
  if (state.gaps[`adjustment:${voucher.id}`]) return false;
  return voucher.applicationRefs.every(ref => state.applications[ref] && !state.gaps[`application:${ref}`]);
}

export function present(state) {
  const periods = {};
  const feeIndex = new Map();
  const evidence = [];
  const ensurePeriod = month => periods[month] ??= {
    month, statements: [], amount: 0, waybills: {},
    vouchersIssued: [], applicationsSettled: [], appliedDeductions: {}, resolvedApplied: 0,
    evidence: [], incompleteReasons: [], openDestinations: [], complete: true,
  };

  // 结算清单与费用行：收件口径只统计原始费用，抵扣不会改写运单金额或一月原始账单。
  for (const [id, statement] of Object.entries(state.statements)) {
    const period = ensurePeriod(statement.month);
    period.statements.push(id);
    evidence.push({ kind: 'statement', month: statement.month, at: statement.receivedAt, statementId: id });
    period.evidence.push({ kind: 'statement', statementId: id, receivedAt: statement.receivedAt });
    for (const fee of Object.values(statement.fees)) {
      period.amount += fee.amount;
      period.waybills[fee.waybill] = (period.waybills[fee.waybill] ?? 0) + fee.amount;
      feeIndex.set(fee.feeId, { fee, statementId: id, feeMonth: statement.month, vouchers: [] });
    }
  }

  const feeView = [];
  const voucherView = [];
  for (const [id, voucher] of Object.entries(state.vouchers)) {
    const totals = voucherTotals(voucher, state);
    const reliable = reliableVoucher(voucher, state);
    const remaining = voucher.amount - totals.applied;
    const view = {
      voucherId: id,
      feeId: voucher.feeId,
      amount: voucher.amount,
      status: voucher.status,
      issuedAt: voucher.issuedAt,
      issueMonth: epochMonth(voucher.issuedAt),
      receivedAt: voucher.receivedAt,
      applicationRefs: [...voucher.applicationRefs],
      applied: totals.applied,
      reversed: totals.reversed,
      netApplied: totals.netApplied,
      claimableBalance: voucher.status === 'withdrawn' ? 0 : remaining,
      effect: voucherEffect(voucher, totals),
      reliable,
      feeLineKnown: feeIndex.has(voucher.feeId),
      applications: totals.applications.map(application => ({
        applicationId: application.applicationId,
        statementId: application.statementId,
        amount: application.amount,
        kind: application.kind,
        appliedAt: application.appliedAt,
        settlementMonth: epochMonth(application.appliedAt),
        settlementKnown: Boolean(state.statements[application.statementId]),
      })),
    };
    voucherView.push(view);
    const issuedPeriod = ensurePeriod(view.issueMonth);
    issuedPeriod.vouchersIssued.push(id);
    issuedPeriod.evidence.push({ kind: 'voucher', voucherId: id, feeId: voucher.feeId, status: voucher.status, issuedAt: voucher.issuedAt, receivedAt: voucher.receivedAt });
    evidence.push({ kind: 'voucher', month: view.issueMonth, at: voucher.issuedAt, voucherId: id, feeId: voucher.feeId, status: voucher.status });

    for (const application of totals.applications) {
      const settlementMonth = epochMonth(application.appliedAt);
      const settlementPeriod = ensurePeriod(settlementMonth);
      settlementPeriod.applicationsSettled.push(application.applicationId);
      settlementPeriod.evidence.push({ kind: 'application', applicationId: application.applicationId, voucherId: id, statementId: application.statementId, amount: application.amount, applicationKind: application.kind, appliedAt: application.appliedAt, receivedAt: application.receivedAt });
      evidence.push({ kind: 'application', month: settlementMonth, at: application.appliedAt, applicationId: application.applicationId, voucherId: id, statementId: application.statementId });
      if (application.kind === 'apply') {
        settlementPeriod.appliedDeductions[application.statementId] = (settlementPeriod.appliedDeductions[application.statementId] ?? 0) + application.amount;
        if (state.statements[application.statementId]) settlementPeriod.resolvedApplied += application.amount;
        else settlementPeriod.openDestinations.push({ applicationId: application.applicationId, statementId: application.statementId, amount: application.amount });
      }
    }
  }

  // 沿一笔费用追溯：原始费用行 → 针对它开立的凭据 → 每次抵扣/冲回去向。
  for (const [feeId, entry] of feeIndex) {
    const feeVouchers = voucherView.filter(voucher => voucher.feeId === feeId);
    let verifiedDeducted = 0;
    for (const voucher of feeVouchers) if (voucher.reliable) verifiedDeducted += voucher.netApplied;
    feeView.push({
      feeId,
      statementId: entry.statementId,
      feeMonth: entry.feeMonth,
      waybill: entry.fee.waybill,
      originalAmount: entry.fee.amount,
      verifiedDeducted,
      pendingVerification: feeVouchers.some(voucher => !voucher.reliable),
      vouchers: feeVouchers.map(voucher => voucher.voucherId),
    });
  }

  const pending = Object.entries(state.gaps).map(([gapKey, gap]) => ({
    gapKey,
    kind: gap.kind,
    ref: gap.ref,
    detail: gap.detail,
    detectedAt: gap.at,
  }));

  // 完整性：源端只给部分明细时保持待核实，不允许对外声称该月已完整。
  for (const statement of Object.values(state.statements)) {
    const period = periods[statement.month];
    for (const voucherId of statement.adjustmentRefs) {
      if (state.gaps[`adjustment:${voucherId}`]) period.incompleteReasons.push({ kind: 'voucher-missing', voucherId });
      const voucher = state.vouchers[voucherId];
      if (!voucher) {
        if (!state.gaps[`adjustment:${voucherId}`]) period.incompleteReasons.push({ kind: 'voucher-unresolved', voucherId });
        continue;
      }
      for (const applicationId of voucher.applicationRefs) {
        if (!state.applications[applicationId] || state.gaps[`application:${applicationId}`]) period.incompleteReasons.push({ kind: 'application-missing', voucherId, applicationId });
      }
    }
  }
  for (const period of Object.values(periods)) {
    period.complete = period.incompleteReasons.length === 0;
    period.evidence.sort((a, b) => (a.receivedAt ?? a.issuedAt ?? 0) - (b.receivedAt ?? b.issuedAt ?? 0));
  }
  evidence.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));

  return { fees: feeView, vouchers: voucherView, periods, months: periods, evidence, pending };
}
