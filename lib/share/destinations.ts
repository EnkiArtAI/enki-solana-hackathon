import { caption, shortText, type CaptionBlock } from "./content";

/**
 * Where a card goes. No destination takes an image from the web by address, and
 * a press never leaves a file on the device: where the OS sheet fits, it gets the
 * files; X and Threads on a desktop open with the words, the card on the clipboard;
 * elsewhere the destination opens and the sentence says the card cannot reach it.
 * Each sentence says only what really happened and what is left to do. Instagram's
 * slide limit and first-image crop: its Content Publishing docs (2026-11-04); that
 * several files pass through a share sheet is documented nowhere, so the sheet's
 * sentence keeps a way out.
 */
export type Dest = "X" | "Instagram" | "Pinterest" | "Threads" | "TikTok";

/** Each destination's format. */
export const DEST: Record<Dest, string> = { X: "16:9", Instagram: "4:5", Pinterest: "2:3", Threads: "4:5", TikTok: "9:16" };

/** X counts a link as 23 characters; 280 less that and its space, when one goes. Threads takes 500. */
const X_ROOM = 280, X_LINK = 24, THREADS_ROOM = 500;

/** The post's link goes with it only while it stands in the post: one left out, or on the card, stays away. */
const hasLink = (blocks: CaptionBlock[]) => blocks.some((b) => b.key === "link");

/** The two with an address that carries the post's words. */
const isIntent = (dest: Dest): dest is "X" | "Threads" => dest === "X" || dest === "Threads";

/** The words an intent address carries. */
const intentText = (dest: "X" | "Threads", blocks: CaptionBlock[]) => shortText(blocks, dest === "X" ? X_ROOM - (hasLink(blocks) ? X_LINK : 0) : THREADS_ROOM);

/** The page a destination opens on. Pinterest's create address needs a public image, a card has none: its home. */
export function destAddress(dest: Dest, blocks: CaptionBlock[], link: string): string {
  const url = hasLink(blocks) ? `&url=${encodeURIComponent(link)}` : "";
  if (dest === "X") return `https://x.com/intent/tweet?text=${encodeURIComponent(intentText(dest, blocks))}${url}`;
  if (dest === "Threads") return `https://www.threads.com/intent/post?text=${encodeURIComponent(intentText(dest, blocks))}${url}`;
  return { Instagram: "https://www.instagram.com/", Pinterest: "https://www.pinterest.com/", TikTok: "https://www.tiktok.com/upload" }[dest];
}

/** What the sentences may tell a person to do depends on the device in hand. */
export type Device = "pc" | "mac" | "touch";

const COPIED = (where: string) => `Your text is copied: paste it as the ${where}.`;
const NOT_COPIED = "Copying your text failed: it stands below, copy it by hand.";
const PASTE: Record<Device, string> = { pc: "paste it with Ctrl+V", mac: "paste it with Cmd+V", touch: "paste it into your post" };
/** The way out when the card cannot reach the site from here. */
const ELSEWHERE = (device: Device, it: string) => (device === "touch" ? "try another browser" : `post ${it} from your phone`);

/** X or Threads without a sheet: what the address carried and whether the card reached the clipboard. `whole`: the whole text stands below, cut to fit or never sent. */
export function pasteSentence(dest: "X" | "Threads", cardCopied: boolean, opened: boolean, link = true, words = true, whole = false, device: Device = "pc"): string {
  const brought = words ? ` with your text${link ? " and link" : ""}` : link ? " with your link" : "";
  const gone = opened ? `${dest} opened${brought}` : `Your browser blocked the new tab, so open ${dest} yourself`;
  const card = cardCopied ? `your card is copied, ${PASTE[device]}.` : `copying your card failed, so ${opened ? `${dest} has no card yet` : "it is not on your clipboard"}: ${ELSEWHERE(device, "it")}.`;
  const below = !whole ? "" : opened ? " Your text was cut to fit: the whole of it stands below." : " Your text stands below.";
  return `${gone}; ${card}${below}`;
}

/** Instagram, Pinterest or TikTok without a sheet: the site opens, the card stays here. */
export function deskSentence(dest: Dest, n: number, copied: boolean, opened: boolean, hasText = true, device: Device = "pc"): string {
  const text = !hasText ? "" : copied ? COPIED(dest === "Pinterest" ? "description" : "caption") : NOT_COPIED;
  const card = n > 1 ? `these ${n} images` : "your card", it = n > 1 ? "them" : "it";
  const gone = opened ? `${dest} opened.` : `Your browser blocked the new tab, so open ${dest} yourself.`;
  return `${gone} This browser cannot hand ${card} to ${dest}: ${ELSEWHERE(device, it)}. ${text}`.trim();
}

/** What to do in the sheet that just opened. Whether a sheet on a desktop lists the app, or several files pass through it, is not known here. */
export function sheetSentence(dest: Dest, n: number, copied: boolean, hasText = true, device: Device = "touch"): string {
  const text = !hasText ? "" : copied ? COPIED("caption") : NOT_COPIED;
  const out = device !== "touch"
    ? ` If it is not listed${n > 1 ? " or takes only one image" : ""}, ${ELSEWHERE(device, n > 1 ? "them" : "it")}.`
    : n > 1 ? ` If it takes only one image, send all ${n} to your photos from the sheet and add them on ${dest}.` : "";
  return `Pick ${dest} in the sheet.${out} ${text}`.trim();
}

const coarse = () => window.matchMedia("(pointer: coarse)").matches;
const device = (): Device => (coarse() ? "touch" : /Mac/.test(navigator.platform) ? "mac" : "pc");

/** Where the OS sheet takes the files. Windows answers canShare on a desktop too and its sheet has no X or Threads: those two take it on a touch device only. */
export function sheetFits(dest: Dest, files: File[]): boolean {
  return typeof navigator.canShare === "function" && navigator.canShare({ files }) && (!isIntent(dest) || coarse());
}

/** Whether a format's file will want a PNG beside it: the clipboard takes no JPEG, and a press cannot wait for one. */
export const wantsPng = (ratio: string, files: File[]) => (ratio === DEST.X || ratio === DEST.Threads) && !sheetFits("X", files);

const copy = (text: string) => (text ? navigator.clipboard?.writeText(text).then(() => true, () => false) ?? Promise.resolve(false) : Promise.resolve(true));

/** The card as a picture on the clipboard. No PNG, no ClipboardItem in this browser, or a refusal: false. */
function copyCard(png: Blob | undefined): Promise<boolean> {
  try {
    return navigator.clipboard.write([new ClipboardItem({ [png!.type]: png! })]).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

function openTab(dest: Dest, blocks: CaptionBlock[], link: string) {
  const tab = window.open(destAddress(dest, blocks, link), "_blank");
  if (tab) tab.opener = null;
  return !!tab;
}

/**
 * Sends the files on, all of it inside the press that called it: nothing before
 * the first step may wait, or the browser takes away its leave to share, to copy
 * and to open a tab. `say` hears each sentence; `byHand` in the answer: the text
 * reached no destination and no clipboard, so the popup shows it. A post with no
 * text leaves the clipboard as it was and says nothing of text.
 */
export async function deliver(dest: Dest, files: File[], blocks: CaptionBlock[], link: string, say: (sentence: string) => void, png?: Blob): Promise<{ byHand: boolean }> {
  const text = caption(blocks), n = files.length, on = device();
  if (sheetFits(dest, files)) {
    const copying = copy(text);
    const sharing = navigator.share({ files, ...(text ? { text } : null) });
    const copied = await copying;
    say(sheetSentence(dest, n, copied, !!text, on));
    await sharing.then(
      () => say(`Handed to the app you picked. ${!text ? "" : copied ? "Your text is copied too." : NOT_COPIED}`.trim()),
      (e: Error) => say(e?.name === "AbortError" ? `Nothing was shared. ${text && copied ? "Your text is copied." : ""}`.trim() : "The share sheet failed, so nothing was shared. Press again to retry."),
    );
    return { byHand: !copied };
  }
  if (isIntent(dest)) {
    // The write first: the new tab takes the focus, and a page without it may not write.
    const copying = copyCard(png);
    const opened = openTab(dest, blocks, link);
    const cardCopied = await copying;
    const words = intentText(dest, blocks), cut = words !== caption(blocks.filter((b) => b.key !== "link"));
    const byHand = !!text && (cut || !opened);
    say(pasteSentence(dest, cardCopied, opened, hasLink(blocks), !!words, byHand, on));
    return { byHand };
  }
  const copying = copy(text);
  const opened = openTab(dest, blocks, link);
  const copied = await copying;
  say(deskSentence(dest, n, copied, opened, !!text, on));
  return { byHand: !copied };
}
