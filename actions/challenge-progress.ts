"use server";

import { auth } from "@clerk/nextjs";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { MAX_HEARTS } from "@/constants";
import db from "@/db/drizzle";
import { getUserProgress, getUserSubscription } from "@/db/queries";
import { challengeProgress, challenges, userProgress } from "@/db/schema";

// 处理用户提交了正确答案的情况
export const upsertChallengeProgress = async (challengeId: number) => {
  const { userId } = auth();
  if (!userId) throw new Error("Unauthorized.");

  const currentUserProgress = await getUserProgress();
  const userSubscription = await getUserSubscription();

  if (!currentUserProgress) throw new Error("User progress not found.");

  const challenge = await db.query.challenges.findFirst({
    where: eq(challenges.id, challengeId),
  });

  if (!challenge) throw new Error("Challenge not found.");

  const lessonId = challenge.lessonId;

  // 找到第一个当前用户 + 当前挑战的 挑战进度
  const existingChallengeProgress = await db.query.challengeProgress.findFirst({
    where: and(
      eq(challengeProgress.userId, userId),
      eq(challengeProgress.challengeId, challengeId)
    ),
  });

  // 根据是否已经存在挑战进度 决定本次是否是练习
  const isPractice = !!existingChallengeProgress;

  // 如果当前非练习 + 非会员 + 体力值为0 -> 后端不再进行后续处理 + 告知前端♥已经用完！
  if (
    currentUserProgress.hearts === 0 &&
    !isPractice &&
    !userSubscription?.isActive
  )
    return { error: "hearts" };

  // 对于练习情况
  if (isPractice) {
    // 下面这一行感觉没用 因为查到的挑战进度都应该是completed的
    await db
      .update(challengeProgress)
      .set({
        completed: true,
      })
      .where(eq(challengeProgress.id, existingChallengeProgress.id));
    // 加♥加分
    await db
      .update(userProgress)
      .set({
        hearts: Math.min(currentUserProgress.hearts + 1, MAX_HEARTS),
        points: currentUserProgress.points + 10,
      })
      .where(eq(userProgress.userId, userId));
    // 用到 ♥ 和 分数的地方都要revalidate
    revalidatePath("/learn");
    revalidatePath("/lesson");
    revalidatePath("/quests");
    revalidatePath("/leaderboard");
    revalidatePath(`/lesson/${lessonId}`);
    return;
  }
  // ！！ 对于非练习情况(第一次做)：
  // 插入新的挑战进度
  await db.insert(challengeProgress).values({
    challengeId,
    userId,
    completed: true,
  });

  // 第一次做 只拿分 不回血
  await db
    .update(userProgress)
    .set({
      points: currentUserProgress.points + 10,
    })
    .where(eq(userProgress.userId, userId));

  revalidatePath("/learn");
  revalidatePath("/lesson");
  revalidatePath("/quests");
  revalidatePath("/leaderboard");
  revalidatePath(`/lesson/${lessonId}`);
};
