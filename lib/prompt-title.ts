/** Every prompt has a real title (Kev, 2026-10-17: "jeder prompt soll einen titel zwangsweise haben"): blank or a
 * placeholder is none. */
export const isRealTitle = (title: unknown): title is string =>
  typeof title === "string" && !!title.trim() && !/^untitled(\s+prompt)?$/i.test(title.trim());
