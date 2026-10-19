import type {
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
