import { cache } from "react";

import { auth } from "@clerk/nextjs";
import { eq } from "drizzle-orm";

import db from "./drizzle";
import {
  challengeProgress,
  courses,
  lessons,
  units,
  userProgress,
  userSubscription,
} from "./schema";

const DAY_IN_MS = 86_400_000;

export const getCourses = cache(async () => {
  const data = await db.query.courses.findMany();

  return data;
});

export const getUserProgress = cache(async () => {
  const { userId } = auth(); // 从clerk拿用户信息！！

  if (!userId) return null;

  const data = await db.query.userProgress.findFirst({
    where: eq(userProgress.userId, userId),
    with: {
      activeCourse: true,
    },
  });

  return data;
});

// 在learn page调用
// 这个方法cache了 那在切换课程的时候一定要revalidate: actions\user-progress.ts中的upsertUserProgress方法
// 这个方法代码的要点：UserProgress记录当前用户上哪门课  ChallengeProgress记录用户是否完成某个挑战  而“课”和“挑战”之间有单元+课程
export const getUnits = cache(async () => {
  // 先通过clerk的api找到当前用户
  const { userId } = auth();
  const userProgress = await getUserProgress(); // 先找当前的course
  // 特判 无所谓
  if (!userId || !userProgress?.activeCourseId) return [];

  // 多表联合查询返回一个嵌套JS对象：单元.[单元的所有课程.[课程的所有挑战.[该用户的所有进度]]]
  const data = await db.query.units.findMany({
    where: eq(units.courseId, userProgress.activeCourseId), // 当前用户上的当前课的所有单元
    orderBy: (units, { asc }) => [asc(units.order)],
    with: {
      lessons: {
        orderBy: (lessons, { asc }) => [asc(lessons.order)],
        with: {
          challenges: {
            orderBy: (challenges, { asc }) => [asc(challenges.order)],
            with: {
              challengeProgress: {
                where: eq(challengeProgress.userId, userId),
              },
            },
          },
        },
      },
    },
  });

  // 为每一个单元的每一个lesson添加一个是否全部完成的标志 -> 看lesson里的所有challenges是否都完成
  const normalizedData = data.map((unit) => {
    const lessonsWithCompletedStatus = unit.lessons.map((lesson) => {
      // lesson里要有challenges 否则lesson视作未完成
      if (lesson.challenges.length === 0)
        return { ...lesson, completed: false };

      // boolean类型 看lesson里的所有challenges是否都完成
      const allCompletedChallenges = lesson.challenges.every((challenge) => {
        return (
          challenge.challengeProgress &&
          challenge.challengeProgress.length > 0 &&
          challenge.challengeProgress.every((progress) => progress.completed) // 这里很奇怪，同一个用户同一个challenge 能有多个challenge progress？
        );
      });
      return { ...lesson, completed: allCompletedChallenges };
    });

    // 返回单元 + 单元里的所有课（附带是否完成的标志）
    return { ...unit, lessons: lessonsWithCompletedStatus };
  });

  // 返回单元
  return normalizedData;
});

export const getCourseById = cache(async (courseId: number) => {
  const data = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
    with: {
      units: {
        orderBy: (units, { asc }) => [asc(units.order)],
        with: {
          lessons: {
            orderBy: (lessons, { asc }) => [asc(lessons.order)],
          },
        },
      },
    },
  });

  return data;
});

// 找到当前正在进行的(第一个未完成的)lesson
export const getCourseProgress = cache(async () => {
  const { userId } = auth();
  const userProgress = await getUserProgress(); // 先找当前的course

  if (!userId || !userProgress?.activeCourseId) return null;

  // 又是这个多表联合查询返回嵌套对象
  const unitsInActiveCourse = await db.query.units.findMany({
    orderBy: (units, { asc }) => [asc(units.order)], // 这里排序很重要 因为要找到第一个符合条件的lesson
    where: eq(units.courseId, userProgress.activeCourseId),
    with: {
      lessons: {
        orderBy: (lessons, { asc }) => [asc(lessons.order)], // 这里排序很重要 因为要找到第一个符合条件的lesson
        with: {
          unit: true,
          challenges: {
            with: {
              challengeProgress: {
                where: eq(challengeProgress.userId, userId),
              },
            },
          },
        },
      },
    },
  });

  // 找到第一个未完成的lesson
  const firstUncompletedLesson = unitsInActiveCourse
    .flatMap((unit) => unit.lessons) // 拍平当前course的所有lessons
    .find((lesson) => {
      // 找到第一个符合条件的lesson
      // 检查这个lesson的challenges，看是否有challenge没有progress或progress为未完成
      return lesson.challenges.some((challenge) => {
        return (
          !challenge.challengeProgress ||
          challenge.challengeProgress.length === 0 ||
          challenge.challengeProgress.some((progress) => !progress.completed)
        );
      });
    });

  return {
    activeLesson: firstUncompletedLesson,
    activeLessonId: firstUncompletedLesson?.id,
  };
});

// 这个方法有两种情况：
// 1. 调用时不传id 则返回第一个未完成的lesson
// 2. 调用时传id 则返回特定id的lesson
// 返回的lesson附带其所有challenges及其选项(因为lesson page是用来展示所有题目的) 且challenge是增强过的 包含challenge是否完成的标记
export const getLesson = cache(async (id?: number) => {
  const { userId } = auth();

  if (!userId) return null;

  const courseProgress = await getCourseProgress();
  const lessonId = id || courseProgress?.activeLessonId;

  if (!lessonId) return null;

  const data = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
    with: {
      challenges: {
        orderBy: (challenges, { asc }) => [asc(challenges.order)],
        with: {
          challengeOptions: true,
          challengeProgress: {
            where: eq(challengeProgress.userId, userId),
          },
        },
      },
    },
  });

  if (!data || !data.challenges) return null;

  const normalizedChallenges = data.challenges.map((challenge) => {
    const completed =
      challenge.challengeProgress &&
      challenge.challengeProgress.length > 0 &&
      challenge.challengeProgress.every((progress) => progress.completed);

    return { ...challenge, completed };
  });

  return { ...data, challenges: normalizedChallenges };
});

// 获得当前lesson的进度百分比 即: 完成的challenge / challenge总数
export const getLessonPercentage = cache(async () => {
  const courseProgress = await getCourseProgress();

  if (!courseProgress?.activeLessonId) return 0;

  const lesson = await getLesson(courseProgress?.activeLessonId);

  if (!lesson) return 0;

  const completedChallenges = lesson.challenges.filter(
    (challenge) => challenge.completed
  );

  const percentage = Math.round(
    (completedChallenges.length / lesson.challenges.length) * 100
  );

  return percentage;
});

export const getUserSubscription = cache(async () => {
  const { userId } = auth();

  if (!userId) return null;

  const data = await db.query.userSubscription.findFirst({
    where: eq(userSubscription.userId, userId),
  });

  if (!data) return null;

  const isActive =
    data.stripePriceId &&
    data.stripeCurrentPeriodEnd?.getTime() + DAY_IN_MS > Date.now();

  return {
    ...data,
    isActive: !!isActive,
  };
});

export const getTopTenUsers = cache(async () => {
  const { userId } = auth();

  if (!userId) return [];

  const data = await db.query.userProgress.findMany({
    orderBy: (userProgress, { desc }) => [desc(userProgress.points)],
    limit: 10,
    columns: {
      userId: true,
      userName: true,
      userImageSrc: true,
      points: true,
    },
  });

  return data;
});
