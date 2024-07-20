import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import Stripe from "stripe";

import db from "@/db/drizzle";
import { userSubscription } from "@/db/schema";
import { stripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const body = await req.text(); // 拿到webhook请求的请求体
  const signature = headers().get("Stripe-Signature") as string; // 拿到请求头中包含的 Stripe 签名，Stripe 使用你的 endpoint secret 对发送的数据进行签名

  let event: Stripe.Event;

  // 验证传入的 Webhook 事件的真实性(是stripe发的)和完整性(发的东西没被篡改)
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET // 在Stripe Dashboard设置Webhook时生成的endpoint secret。用这个secret对body进行加密，将结果和signature比对来验证
    );
  } catch (error: unknown) {
    return new NextResponse(`Webhook error ${JSON.stringify(error)}`, {
      status: 400,
    });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // 订阅
  if (event.type === "checkout.session.completed") {
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription as string
    );

    if (!session?.metadata?.userId)
      return new NextResponse("User id is required.", { status: 400 });

    // 更新数据库
    await db.insert(userSubscription).values({
      userId: session.metadata.userId,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: subscription.customer as string,
      stripePriceId: subscription.items.data[0].price.id, // 对应actions\user-subscription.ts中的stripeSession的price_data
      stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000), // in ms
    });
  }

  // 续订
  if (event.type === "invoice.payment_succeeded") {
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription as string
    );

    // 更新数据库
    await db
      .update(userSubscription)
      .set({
        stripePriceId: subscription.items.data[0].price.id,
        stripeCurrentPeriodEnd: new Date(
          subscription.current_period_end * 1000 // in ms
        ),
      })
      .where(eq(userSubscription.stripeSubscriptionId, subscription.id)); // 根据订阅id找到上次的订阅
  }

  return new NextResponse(null, { status: 200 });
}
