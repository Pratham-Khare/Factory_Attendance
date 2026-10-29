import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayroll } from './payroll.js';

test('uses scheduled workdays for daily rate, unaffected by leave days', () => {
  const payroll = calculatePayroll({ monthlySalary: 26000, payableWorkDays: 26, absentDays: 0 });
  assert.equal(payroll.dailyRate, 1000);
  assert.equal(payroll.finalSalary, 26000);
});

test('deducts absence and unpaid leave exactly once in separate buckets', () => {
  const payroll = calculatePayroll({
    monthlySalary: 26000, payableWorkDays: 26,
    absentDays: 2, unpaidLeaveDays: 1
  });
  assert.equal(payroll.absentDeduction, 2000);
  assert.equal(payroll.unpaidLeaveDeduction, 1000);
  assert.equal(payroll.totalDeductions, 3000);
  assert.equal(payroll.finalSalary, 23000);
});

test('applies half-day, late and overtime calculations', () => {
  const payroll = calculatePayroll({
    monthlySalary: 26000, payableWorkDays: 26,
    halfDayCount: 2, lateCount: 3, lateDeductionRate: 50,
    overtimeHours: 4.5, overtimeRatePerHour: 150
  });
  assert.equal(payroll.halfDayDeduction, 1000);
  assert.equal(payroll.lateDeduction, 150);
  assert.equal(payroll.overtimePay, 675);
  assert.equal(payroll.totalDeductions, 1150);
  assert.equal(payroll.finalSalary, 25525);
});

test('custom deduction rates override automatic rates and salary never goes below zero', () => {
  const payroll = calculatePayroll({
    monthlySalary: 1000, payableWorkDays: 20,
    absentDays: 5, absentDeductionRate: 1000
  });
  assert.equal(payroll.absentRate, 1000);
  assert.equal(payroll.totalDeductions, 5000);
  assert.equal(payroll.finalSalary, 0);
});

test('zero scheduled workdays do not divide by zero', () => {
  const payroll = calculatePayroll({ monthlySalary: 20000, payableWorkDays: 0, absentDays: 0 });
  assert.equal(payroll.dailyRate, 0);
  assert.equal(payroll.finalSalary, 20000);
});
