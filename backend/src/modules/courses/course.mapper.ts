import type {
  CatalogCourse,
  CatalogCourseDetail,
  CatalogInstructor,
  CatalogSection,
  CourseDetail,
  CourseDocument,
  ICourse,
  LessonDocument,
  ManagedCourse,
  PublicCourse,
  PublicLesson,
  PublicSection,
  SectionDocument,
} from './course.types.js';

type CourseLike = CourseDocument | (ICourse & { _id: unknown });

/**
 * Map a Course document into the audience-neutral representation. Review
 * metadata and edit-lock internals are deliberately excluded so this mapper is
 * safe to reuse for public course catalog responses.
 */
export function toPublicCourse(course: CourseLike): PublicCourse {
  return {
    id: String(course._id),
    ownerId: course.ownerId.toString(),
    title: course.title,
    slug: course.slug,
    description: course.description,
    status: course.status,
    thumbnailUrl: course.thumbnailUrl,
    level: course.level,
    language: course.language,
    learningOutcomes: course.learningOutcomes,
    requirements: course.requirements,
    priceMinor: course.priceMinor,
    currency: course.currency,
    publishedAt: course.publishedAt?.toISOString(),
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}

/**
 * Map a Course document into the authorized owner/admin representation,
 * including review metadata but never edit-lock internals.
 */
export function toManagedCourse(course: CourseLike): ManagedCourse {
  return {
    ...toPublicCourse(course),
    submittedAt: course.submittedAt?.toISOString(),
    reviewedAt: course.reviewedAt?.toISOString(),
    reviewedBy: course.reviewedBy?.toString(),
    rejectionReason: course.rejectionReason,
  };
}

/**
 * Map a Lesson document into a sanitized representation. Only the payload that
 * matches the lesson type is ever populated.
 */
export function toPublicLesson(lesson: LessonDocument): PublicLesson {
  return {
    id: lesson._id.toString(),
    title: lesson.title,
    description: lesson.description,
    type: lesson.type,
    order: lesson.order,
    videoId: lesson.videoId?.toString(),
    content: lesson.content,
    documentUrl: lesson.documentUrl,
    documentName: lesson.documentName,
    createdAt: lesson.createdAt.toISOString(),
    updatedAt: lesson.updatedAt.toISOString(),
  };
}

export function toPublicSection(
  section: SectionDocument,
  lessons: LessonDocument[],
): PublicSection {
  return {
    id: section._id.toString(),
    title: section.title,
    description: section.description,
    order: section.order,
    lessons: lessons.map(toPublicLesson),
    createdAt: section.createdAt.toISOString(),
    updatedAt: section.updatedAt.toISOString(),
  };
}

/**
 * Build the full Course Builder representation: metadata plus sections, each
 * with its lessons, in persisted order.
 */
export function toCourseDetail(
  course: CourseLike,
  sections: SectionDocument[],
  lessons: LessonDocument[],
): CourseDetail {
  const lessonsBySection = new Map<string, LessonDocument[]>();

  for (const lesson of lessons) {
    const key = lesson.sectionId.toString();
    const bucket = lessonsBySection.get(key);
    if (bucket) {
      bucket.push(lesson);
    } else {
      lessonsBySection.set(key, [lesson]);
    }
  }

  return {
    ...toManagedCourse(course),
    sections: sections.map((section) =>
      toPublicSection(section, lessonsBySection.get(section._id.toString()) ?? []),
    ),
  };
}

/**
 * Map a published course to its public catalog card.
 *
 * The mapper deliberately omits `ownerId`, review metadata, edit-lease
 * internals and any lesson payload. Instructor data is limited to the display
 * name and avatar.
 */
export function toCatalogCourse(
  course: CourseLike,
  instructor: CatalogInstructor,
): CatalogCourse {
  const priceMinor = course.priceMinor ?? 0;

  return {
    id: String(course._id),
    title: course.title,
    slug: course.slug,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl,
    level: course.level,
    language: course.language,
    priceMinor,
    currency: course.currency,
    isFree: priceMinor === 0,
    publishedAt: (course.publishedAt ?? course.createdAt).toISOString(),
    instructor,
  };
}

/**
 * Map a published course and its curriculum outline for the public detail page.
 * Lesson content, video ids and document URLs are never included.
 */
export function toCatalogCourseDetail(
  course: CourseLike,
  instructor: CatalogInstructor,
  sections: SectionDocument[],
  lessons: LessonDocument[],
): CatalogCourseDetail {
  const lessonsBySection = new Map<string, LessonDocument[]>();

  for (const lesson of lessons) {
    const key = lesson.sectionId.toString();
    const bucket = lessonsBySection.get(key);
    if (bucket) {
      bucket.push(lesson);
    } else {
      lessonsBySection.set(key, [lesson]);
    }
  }

  const curriculum: CatalogSection[] = sections.map((section) => {
    const sectionLessons = lessonsBySection.get(section._id.toString()) ?? [];
    return {
      id: section._id.toString(),
      title: section.title,
      order: section.order,
      lessonCount: sectionLessons.length,
      lessons: sectionLessons.map((lesson) => ({
        id: lesson._id.toString(),
        title: lesson.title,
        type: lesson.type,
        order: lesson.order,
      })),
    };
  });

  return {
    ...toCatalogCourse(course, instructor),
    learningOutcomes: course.learningOutcomes ?? [],
    requirements: course.requirements ?? [],
    curriculum,
    totalSections: curriculum.length,
    totalLessons: curriculum.reduce(
      (total, section) => total + section.lessonCount,
      0,
    ),
  };
}
