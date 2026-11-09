/**
 * Settings' areas, in the bar's order (Kev, 2026-11-08: the Settings mock v64 replaces today's Settings, "so wie sie sind
 * präzise verdrahtet"; Main.dc.html NAMES): App, Content, Account, Money, Safety. Money holds four tabs, and Settings opens
 * on its Balance, as the mock does (`area: 3`, `mtab: 0`).
 */
export const AREAS = [
  { key: "app", label: "App" },
  { key: "content", label: "Content" },
  { key: "account", label: "Account" },
  { key: "money", label: "Money" },
  { key: "safety", label: "Safety" },
] as const;
export type Area = (typeof AREAS)[number]["key"];

/** Money's tabs. API's panel is greyed as coming (Kev: "except for API and the group workspaces that you simply grey out"). */
export const MONEY_TABS = [
  { key: "balance", label: "Balance" },
  { key: "usage", label: "Usage" },
  { key: "api", label: "API" },
  { key: "billing", label: "Billing" },
] as const;
export type MoneyTab = (typeof MONEY_TABS)[number]["key"];

/** A place in Settings: its area, and the tab Money shows when it is picked. */
export type SettingsAt = { area: Area; money: MoneyTab };
export const SETTINGS_HOME: SettingsAt = { area: "money", money: "balance" };

const at = (area: Area, money: MoneyTab = "balance"): SettingsAt => ({ area, money });
/* Today's three tabs keep their addresses and embedders (?tab=, ?settings=, initialTab): Profile's functions moved to
   Account, Payment's to Money's Balance, Recovery & 2FA's to Safety. ?tab=billing stays Balance: the old "Add funds" links
   and the onramp's way back mean the money, not the statements. */
const IDS: Record<string, SettingsAt> = {
  ...Object.fromEntries(AREAS.map((a) => [a.key, at(a.key)])),
  ...Object.fromEntries(MONEY_TABS.map((t) => [`money/${t.key}`, at("money", t.key)])),
  profile: at("account"),
  payment: at("money"),
  billing: at("money"),
  recovery: at("safety"),
};

/** Where a tab id lands: an area, money/<tab>, or one of today's tabs; anything else is Settings' home. */
export const settingsAt = (tab: string | null | undefined): SettingsAt =>
  tab && Object.hasOwn(IDS, tab) ? IDS[tab] : SETTINGS_HOME;
