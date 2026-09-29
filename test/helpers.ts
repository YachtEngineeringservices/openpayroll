import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RuleSet } from "../src/rules.js";
import type { PayRunInput } from "../src/types.js";

// compiled to dist/test/*.js; sources live at <root>/test and <root>/rules
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fixtureRules = () => RuleSet.load(join(ROOT, "test", "fixtures", "rules"));
export const realRules = () => RuleSet.load(join(ROOT, "rules"));

export function baseInput(over: Partial<PayRunInput> = {}): PayRunInput {
  return {
    employer: { name: "Test Co", caUiRate: "0.034" },
    employee: {
      id: "E1", name: "Test Employee", workState: "CA",
      w4: { version: "2020+", filingStatus: "single", step2Checkbox: false, step3Credits: "0", step4aOtherIncome: "0", step4bDeductions: "0", step4cExtra: "0" },
      de4: { filingStatus: "single", regularAllowances: 1, estimatedDeductionAllowances: 0, additional: "0" },
    },
    period: { frequency: "semimonthly", start: "2099-01-01", end: "2099-01-15", payDate: "2099-01-15" },
    earnings: [{ code: "salary", amount: "5000.00" }],
    ytd: { ssWages: "0", medicareWages: "0", futaWages: "0", caUiWages: "0", caSdiWages: "0" },
    ...over,
  };
}

export const tax = (r: { taxes: { code: string; amount: string; taxableWages: string }[] }, code: string) =>
  r.taxes.find(t => t.code === code);
