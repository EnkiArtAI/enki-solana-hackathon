/**
 * x402 discovery manifest — how an agent FINDS the payable resources
 * (the Apify moment: the agent in Kev's reference discovered the paid API
 * on its own; this file is what makes Enki discoverable the same way).
 * Public by design; the proxy allowlists /.well-known/. It names the same
 * network and absolute resource the 402 does (Kev, 2026-10-17).
 */
import { NextRequest, NextResponse } from "next/server";
import { x402ChainKey } from "@/lib/payments/solana";
import { x402Network } from "@/lib/payments/x402-settle";

export async function GET(req: NextRequest) {
  return NextResponse.json({
    x402Version: 1,
    name: "Enki Art",
    description:
      "AI image marketplace. Generate images from curated artist prompts or plain text — priced per image, paid in USDC on Solana via x402. Artists earn a licence fee on every prompt-backed generation.",
    network: x402Network(x402ChainKey()).v1,
    resources: [
      {
        resource: new URL("/api/x402/generate", req.nextUrl.origin).href,
        method: "POST",
        description:
          "Generate one image. Body: { prompt } for plain text, or { promptId, variableValues } to use an artist's prompt (the licence is included in the price; Enki pays the artist). Required: modelFamily (nano-banana-pro | nano-banana-2 | gpt-image-2 | gpt-image-2-5-flare | gpt-image-2-5-sunburst). Optional: resolution (1K|2K|4K), aspectRatio (1:1|2:3|3:2|3:4|4:3|4:5|5:4|9:16|16:9|21:9), quality. variableValues go with a promptId only. The pricing fields may also ride in the URL query, so a request without a body still gets its 402. A request without a payment answers 402 with exact requirements, as the v1 JSON body and as the v2 PAYMENT-REQUIRED header: extra.feePayer carries our gas payer (you only need USDC). Pay with one TransferChecked of the exact amount to payTo (extra.legs repeats it as its one entry). Send the partially signed transaction back in X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2); we co-sign, settle and answer with the image.",
        status: "live — plain prompts, free/showcase prompts and priced artist prompts (licence included)",
      },
    ],
  });
}
