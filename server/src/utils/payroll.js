const nonNegative = value => Math.max(0, Number(value) || 0);
const money = value => Number((Number.isFinite(value) ? value : 0).toFixed(2));

/**
 * Calculates monthly payroll using explicit, non-overlapping deduction buckets.
 * A custom deduction greater than zero overrides its automatic daily-rate default;
 * zero/blank uses the automatic default for half-day, absence and unpaid leave.
 */
export function calculatePayroll({
  monthlySalary = 0,
  payableWorkDays = 0,
  overtimeHours = 0,
  overtimeRatePerHour = 0,
  halfDayCount = 0,
  absentDays = 0,
  lateCount = 0,
  unpaidLeaveDays = 0,
  halfDayDeductionRate = 0,
  absentDeductionRate = 0,
  lateDeductionRate = 0,
  unpaidLeaveDeductionRate = 0
}) {
  const base = nonNegative(monthlySalary);
  const workDays = nonNegative(payableWorkDays);
  const dailyRate = workDays > 0 ? base / workDays : 0;
  const otHours = nonNegative(overtimeHours);
  const otRate = nonNegative(overtimeRatePerHour);
  const halfCount = nonNegative(halfDayCount);
  const absentCount = nonNegative(absentDays);
  const late = nonNegative(lateCount);
  const unpaid = nonNegative(unpaidLeaveDays);

  const halfRate = nonNegative(halfDayDeductionRate) > 0 ? nonNegative(halfDayDeductionRate) : dailyRate / 2;
  const absentRate = nonNegative(absentDeductionRate) > 0 ? nonNegative(absentDeductionRate) : dailyRate;
  const lateRate = nonNegative(lateDeductionRate);
  const unpaidRate = nonNegative(unpaidLeaveDeductionRate) > 0 ? nonNegative(unpaidLeaveDeductionRate) : dailyRate;

  const overtimePay = otHours * otRate;
  const grossPay = base + overtimePay;
  const halfDayDeduction = halfCount * halfRate;
  const absentDeduction = absentCount * absentRate;
  const lateDeduction = late * lateRate;
  const unpaidLeaveDeduction = unpaid * unpaidRate;
  const totalDeductions = halfDayDeduction + absentDeduction + lateDeduction + unpaidLeaveDeduction;

  return {
    monthlySalary: money(base),
    payableWorkDays: workDays,
    dailyRate: money(dailyRate),
    overtimeHours: money(otHours),
    overtimeRatePerHour: money(otRate),
    overtimePay: money(overtimePay),
    grossPay: money(grossPay),
    halfDayCount: halfCount,
    halfDayRate: money(halfRate),
    halfDayDeduction: money(halfDayDeduction),
    absentDays: absentCount,
    absentRate: money(absentRate),
    absentDeduction: money(absentDeduction),
    lateCount: late,
    lateRate: money(lateRate),
    lateDeduction: money(lateDeduction),
    unpaidLeaveDays: unpaid,
    unpaidLeaveRate: money(unpaidRate),
    unpaidLeaveDeduction: money(unpaidLeaveDeduction),
    totalDeductions: money(totalDeductions),
    finalSalary: money(Math.max(0, grossPay - totalDeductions))
  };
}
