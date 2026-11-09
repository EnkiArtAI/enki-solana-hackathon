"use client";

import { useId } from "react";
import { siApplepay, siGooglepay, siPaypal, siVisa } from "simple-icons";

export type RampProvider = "coinbase" | "moonpay";

/* The brands' own marks, as the mock draws them (Provider.dc.html): Coinbase's wordmark (its press kit) in its blue,
   MoonPay's lockup with its purple mark and the word in the text's colour, so it reads in every theme. */
const COINBASE = "M222.34,54.94c-40.02,0-71.29,30.38-71.29,71.05s30.48,70.79,71.29,70.79c40.81,0,71.82-30.64,71.82-71.05C294.16,85.58,263.68,54.94,222.34,54.94z M222.61,167.47c-22.79,0-39.49-17.7-39.49-41.47c0-24.04,16.43-41.73,39.22-41.73c23.06,0,39.75,17.96,39.75,41.73S245.4,167.47,222.61,167.47z M302.9,85.85h19.88v108.3h31.8V57.58H302.9V85.85z M71.02,84.26c16.7,0,29.95,10.3,34.98,25.62h33.66c-6.1-32.75-33.13-54.94-68.37-54.94C31.27,54.94,0,85.32,0,126s30.48,70.79,71.29,70.79c34.45,0,62.01-22.19,68.11-55.21H106c-4.77,15.32-18.02,25.89-34.72,25.89c-23.06,0-39.22-17.7-39.22-41.47C32.07,101.96,47.97,84.26,71.02,84.26z M907.12,112.79l-23.32-3.43c-11.13-1.58-19.08-5.28-19.08-14c0-9.51,10.34-14.26,24.38-14.26c15.37,0,25.18,6.6,27.3,17.43h30.74c-3.45-27.47-24.65-43.58-57.24-43.58c-33.66,0-55.92,17.17-55.92,41.47c0,23.24,14.58,36.72,43.99,40.94l23.32,3.43c11.4,1.58,17.76,6.08,17.76,14.53c0,10.83-11.13,15.32-26.5,15.32c-18.82,0-29.42-7.66-31.01-19.28h-31.27c2.92,26.68,23.85,45.43,62.01,45.43c34.72,0,57.77-15.85,57.77-43.06C950.05,129.43,933.36,116.75,907.12,112.79z M338.68,1.32c-11.66,0-20.41,8.45-20.41,20.07s8.74,20.07,20.41,20.07c11.66,0,20.41-8.45,20.41-20.07S350.34,1.32,338.68,1.32z M805.36,104.34c0-29.58-18.02-49.39-56.18-49.39c-36.04,0-56.18,18.23-60.16,46.23h31.54c1.59-10.83,10.07-19.81,28.09-19.81c16.17,0,24.12,7.13,24.12,15.85c0,11.36-14.58,14.26-32.6,16.11c-24.38,2.64-54.59,11.09-54.59,42.79c0,24.57,18.29,40.41,47.44,40.41c22.79,0,37.1-9.51,44.26-24.57c1.06,13.47,11.13,22.19,25.18,22.19h18.55v-28.26h-15.64V104.34z M774.09,138.68c0,18.23-15.9,31.7-35.25,31.7c-11.93,0-22-5.02-22-15.58c0-13.47,16.17-17.17,31.01-18.75c14.31-1.32,22.26-4.49,26.24-10.57V138.68z M605.28,54.94c-17.76,0-32.6,7.4-43.2,19.81V0h-31.8v194.15h31.27v-17.96c10.6,12.94,25.71,20.6,43.73,20.6c38.16,0,67.05-30.11,67.05-70.79S642.91,54.94,605.28,54.94z M600.51,167.47c-22.79,0-39.49-17.7-39.49-41.47s16.96-41.73,39.75-41.73c23.06,0,39.22,17.7,39.22,41.73C639.99,149.77,623.3,167.47,600.51,167.47z M454.22,54.94c-20.67,0-34.19,8.45-42.14,20.34v-17.7h-31.54v136.56h31.8v-74.22c0-20.87,13.25-35.66,32.86-35.66c18.29,0,29.68,12.94,29.68,31.7v78.19h31.8v-80.56C506.69,79.24,488.94,54.94,454.22,54.94z M1101.64,121.51c0-39.09-28.62-66.56-67.05-66.56c-40.81,0-70.76,30.64-70.76,71.05c0,42.53,32.07,70.79,71.29,70.79c33.13,0,59.1-19.55,65.72-47.28h-33.13c-4.77,12.15-16.43,19.02-32.07,19.02c-20.41,0-35.78-12.68-39.22-34.87h105.21V121.51z M998.28,110.94c5.04-19.02,19.35-28.26,35.78-28.26c18.02,0,31.8,10.3,34.98,28.26H998.28z";
const MOONPAY_MARK = "M0.0469228 21.8975C0.0469228 14.6476 5.95305 8.74149 13.2029 8.74149C20.4528 8.74149 26.3589 14.6476 26.3589 21.8975C26.3589 29.1474 20.4528 35.0535 13.2029 35.0535C5.95305 35.0535 0.0469228 29.1474 0.0469228 21.8975ZM29.6831 0.041469C26.7125 0.041469 24.3073 2.44664 24.3073 5.4173C24.3073 8.38796 26.7125 10.7931 29.6831 10.7931C32.6538 10.7931 35.059 8.38796 35.059 5.4173C35.059 2.44664 32.6538 0.041469 29.6831 0.041469Z";
const MOONPAY_WORD = "M56.9069 27.809L49.4639 9.2019H42.7656V34.6497H47.3026V15.1563L55.1 34.6497H58.3964L66.1937 15.1923V34.6497H70.8011V9.2019H64.3156L56.9078 27.809H56.9069ZM92.7406 25.2926C92.7406 30.751 88.4524 35.0393 82.9939 35.0393C77.5354 35.0393 73.3184 30.7862 73.3184 25.399C73.3184 20.0117 77.6074 15.6522 83.0651 15.6522C88.5228 15.6522 92.7406 19.9053 92.7406 25.2926ZM88.3812 25.435C88.3812 21.9258 86.1127 19.339 83.0291 19.339C79.9455 19.339 77.677 21.8194 77.677 25.2574C77.677 28.6953 79.9455 31.3534 83.0291 31.3534C86.1127 31.3534 88.3812 28.8721 88.3812 25.4341V25.435ZM113.793 25.2926C113.793 30.751 109.505 35.0393 104.046 35.0393C98.5878 35.0393 94.3708 30.7862 94.3708 25.399C94.3708 20.0117 98.659 15.6522 104.117 15.6522C109.576 15.6522 113.793 19.9053 113.793 25.2926ZM109.434 25.435C109.434 21.9258 107.165 19.339 104.081 19.339C100.998 19.339 98.7294 21.8194 98.7294 25.2574C98.7294 28.6953 100.998 31.3534 104.081 31.3534C107.165 31.3534 109.434 28.8721 109.434 25.4341V25.435ZM126.116 15.6522C123.776 15.6522 121.792 16.6801 120.374 18.5943V16.0426H116.121V34.6497H120.374V23.8048C120.374 21.2171 122.217 19.339 124.627 19.339C127.037 19.339 128.632 21.0403 128.632 23.592V34.6497H132.885V22.6705C132.885 18.5591 130.121 15.6531 126.116 15.6531V15.6522ZM155.644 16.8577C155.644 21.5715 152.135 24.7966 147.067 24.7966H140.793V34.6497H136.257V9.2019H147.208C152.489 9.2019 155.643 12.0727 155.643 16.8577H155.644ZM151.178 16.9993C151.178 14.5188 149.619 13.1006 146.89 13.1006H140.794V20.898H146.89C149.583 20.898 151.178 19.4445 151.178 16.9993ZM170.033 16.0426H174.215V34.6497H170.033V31.8853C168.793 33.905 166.737 35.0393 164.257 35.0393C159.472 35.0393 155.679 30.8214 155.679 25.5053C155.679 20.1893 159.543 15.6522 164.327 15.6522C166.737 15.6522 168.758 16.7513 170.033 18.7006V16.0426ZM170.246 25.399C170.246 21.8546 168.12 19.303 165.142 19.303C162.164 19.303 160.039 21.7842 160.039 25.2222C160.039 28.6601 162.201 31.3534 165.178 31.3534C168.155 31.3534 170.246 28.8721 170.246 25.399ZM189.739 16.0426L184.706 29.2976L179.638 16.0426H174.959L182.402 34.5794L179.708 41.0297H184.315L194.204 16.0434H189.738L189.739 16.0426Z";
const MASTERCARD: [string, string][] = [
  ["#EB001B", "M11.343 18.031c.058.049.12.098.181.146-1.177.783-2.59 1.238-4.107 1.238C3.32 19.416 0 16.096 0 12c0-4.095 3.32-7.416 7.416-7.416 1.518 0 2.931.456 4.105 1.238-.06.051-.12.098-.165.15C9.6 7.489 8.595 9.688 8.595 12c0 2.311 1.001 4.51 2.748 6.031z"],
  ["#F79E1B", "M16.584 4.584c-1.52 0-2.931.456-4.105 1.238.06.051.12.098.165.15C14.4 7.489 15.405 9.688 15.405 12c0 2.31-1.001 4.507-2.748 6.031-.058.049-.12.098-.181.146 1.177.783 2.588 1.238 4.107 1.238C20.68 19.416 24 16.096 24 12c0-4.094-3.32-7.416-7.416-7.416z"],
  ["#FF5F00", "M12 6.174c-.096.075-.189.15-.28.231C10.156 7.764 9.169 9.765 9.169 12c0 2.236.987 4.236 2.551 5.595.09.08.185.158.28.232.096-.074.189-.152.28-.232 1.563-1.359 2.551-3.359 2.551-5.595 0-2.235-.987-4.236-2.551-5.595-.09-.08-.184-.156-.28-.231z"],
];

/* The ways to pay there, each on the white plate the card brands draw their marks for (areas.css .sa-prov-badge). */
type Method = { name: string; w: number; h: number; paths: [string, string][] };
const METHODS: Record<string, Method> = {
  "Apple Pay": { name: "Apple Pay", w: 34, h: 20, paths: [["#000000", siApplepay.path]] },
  "Google Pay": { name: "Google Pay", w: 30, h: 18, paths: [["#5F6368", siGooglepay.path]] },
  PayPal: { name: "PayPal", w: 18, h: 18, paths: [["#002991", siPaypal.path]] },
  Visa: { name: "Visa", w: 30, h: 18, paths: [["#1A1F71", siVisa.path]] },
  Mastercard: { name: "Mastercard", w: 24, h: 18, paths: MASTERCARD },
};

/* What each takes and how fast, in the mock's words (Provider.dc.html:49), and the ways to pay there in its order. */
const PROVIDERS: Record<RampProvider, { name: string; buy: string; sell: string; methods: string[] }> = {
  coinbase: { name: "Coinbase", buy: "Card and Apple Pay · from $5 · minutes", sell: "To your bank · usually the same day", methods: ["Apple Pay", "Visa", "Mastercard"] },
  moonpay: {
    name: "MoonPay", buy: "Card, PayPal, Google Pay and more · from $20", sell: "To your bank, card or PayPal",
    methods: ["Visa", "Mastercard", "PayPal", "Google Pay", "Apple Pay"],
  },
};

/**
 * A payment provider in Settings (the mock v64's Provider part; DEC-2026-11-08-43): its wordmark, what it takes and how
 * fast for adding (buy) or cashing out (sell), the ways to pay there, and a check when it is the one picked. From
 * today's chooser (PaymentPanel.tsx) it keeps "Last used", and greys a provider the server has no keys for as
 * "Coming soon" (GET /api/onramp/session's providers), which cannot be picked.
 */
export default function ProviderCard({ id, side, picked, ready, last, onPick }: {
  id: RampProvider;
  side: "buy" | "sell";
  picked: boolean;
  ready: boolean;
  last: boolean;
  onPick: (id: RampProvider) => void;
}) {
  const p = PROVIDERS[id];
  const subId = useId();
  // One that cannot be used is never shown as the one picked.
  const on = ready && picked;
  return (
    <button type="button" className="sa-prov" aria-pressed={on} aria-label={p.name} aria-describedby={subId}
      disabled={!ready} title={ready ? undefined : "Coming soon"} onClick={() => { if (ready) onPick(id); }}>
      <span className="sa-prov-main">
        <span className="sa-prov-mark">
          {id === "coinbase" ? (
            <svg viewBox="0 0 1101.64 196.79" height="18" role="img" aria-label="Coinbase"><path fill="#0052FF" d={COINBASE} /></svg>
          ) : (
            <svg viewBox="0 0 194.203 41" height="21" role="img" aria-label="MoonPay">
              <path fill="#7D00FF" d={MOONPAY_MARK} />
              <path fill="currentColor" d={MOONPAY_WORD} />
            </svg>
          )}
          {!ready ? <span className="kit-label sa-prov-chip">Coming soon</span> : last ? <span className="kit-label sa-prov-chip">Last used</span> : null}
        </span>
        <span id={subId} className="sa-prov-sub">{side === "buy" ? p.buy : p.sell}</span>
        <span className="sa-prov-badges">
          {p.methods.map((name) => {
            const m = METHODS[name];
            return (
              <span key={name} title={name} className="sa-prov-badge">
                <svg viewBox="0 0 24 24" width={m.w} height={m.h} role="img" aria-label={name}>
                  {m.paths.map(([fill, d]) => <path key={fill} fill={fill} d={d} />)}
                </svg>
              </span>
            );
          })}
        </span>
      </span>
      <span aria-hidden="true" className="sa-prov-check">{on ? "✓" : ""}</span>
    </button>
  );
}
