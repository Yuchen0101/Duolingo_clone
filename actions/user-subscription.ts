"use server";

import { auth, currentUser } from "@clerk/nextjs";

import { getUserSubscription } from "@/db/queries";
import { stripe } from "@/lib/stripe";
import { absoluteUrl } from "@/lib/utils";

const returnUrl = absoluteUrl("/shop"); // 拼接出最后跳转的绝对路径

export const createStripeUrl = async () => {
  const { userId } = auth();
  const user = await currentUser();

  if (!userId || !user) throw new Error("Unauthorized.");

  const userSubscription = await getUserSubscription(); // 1. 从数据库拿用户的订阅情况

  // 2. 对于已经有订阅的用户，创建账单门户的 API。这个账单门户允许客户管理他们的订阅和账单信息，如更新订阅、查看交易记录
  if (userSubscription && userSubscription.stripeCustomerId) {
    const stripeSession = await stripe.billingPortal.sessions.create({
      customer: userSubscription.stripeCustomerId,
      return_url: returnUrl,
    });

    return { data: stripeSession.url }; // 返回这个门户URL给前端 前端会跳转到这个URL
  }

  // 3. 对于还没有订阅的用户，创建支付门户的API
  const stripeSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"], // 这里可以选各种支付方式 包括微信支付
    customer_email: user.emailAddresses[0].emailAddress,
    line_items: [
      // 定义会员的价格和有效期
      {
        quantity: 1,
        price_data: {
          currency: "USD",
          product_data: {
            name: "Lingo Pro",
            description: "Unlimited hearts.",
          },
          unit_amount: 2000, // $20.00 USD
          recurring: {
            interval: "month",
          },
        },
      },
    ],
    metadata: {
      userId, // 很重要 让stripe知道到底是谁付的款，后面webhook返回时会带上这个metadata
    },
    success_url: returnUrl,
    cancel_url: returnUrl,
  });

  return { data: stripeSession.url }; // 返回这个门户URL给前端 前端会跳转到这个URL
};
