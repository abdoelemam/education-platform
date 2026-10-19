import { z } from 'zod';
import {
  COURSE_DESCRIPTION_MAX,
  COURSE_PAGE_DEFAULT_LIMIT,
  COURSE_PAGE_MAX_LIMIT,
  COURSE_REJECTION_REASON_MAX,
  COURSE_TITLE_MAX,
  LESSON_DESCRIPTION_MAX,
  LESSON_DOCUMENT_URL_MAX,
  LESSON_TEXT_CONTENT_MAX,
  LESSON_TITLE_MAX,
  SECTION_DESCRIPTION_MAX,
  SECTION_TITLE_MAX,
} from './course.constants.js';
import { COURSE_STATUSES, LESSON_TYPES } from './course.types.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const objectId = (label: string) =>
  z.string().regex(OBJECT_ID_PATTERN, `Invalid ${label}`);

/**
 * Accept only absolute http(s) URLs with a usable host.
 *
 * The prefix check requires the canonical `//` form and rejects other schemes.
 * The WHATWG parser then rejects malformed input that a prefix-only check would
 * let through, such as `https://`, invalid hosts or out-of-range ports.
 */
function isValidHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      /[a-z0-9]/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

const title = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(max, `Title cannot exceed ${max} characters`);

const description = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Description cannot exceed ${max} characters`)
    .optional();

const documentUrlSchema = z
  .string()
  .trim()
  .max(
    LESSON_DOCUMENT_URL_MAX,
    `Document URL cannot exceed ${LESSON_DOCUMENT_URL_MAX} characters`,
  )
  .refine(isValidHttpUrl, {
    message: 'Document URL must be a valid http(s) URL',
  });

// ---------------------------------------------------------------------------
// Course
// ---------------------------------------------------------------------------

export const createCourseSchema = z.object({
  title: title(COURSE_TITLE_MAX),
  description: description(COURSE_DESCRIPTION_MAX),
});

export type CreateCourseInput = z.infer<typeof createCourseSchema>;

export const updateCourseSchema = z
  .object({
    title: title(COURSE_TITLE_MAX).optional(),
    description: description(COURSE_DESCRIPTION_MAX),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;

export const listCoursesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COURSE_PAGE_MAX_LIMIT)
    .default(COURSE_PAGE_DEFAULT_LIMIT),
});

export type ListCoursesQuery = z.infer<typeof listCoursesQuerySchema>;

// ---------------------------------------------------------------------------
// Teacher Workflow / moderation
// ---------------------------------------------------------------------------

/**
 * Admin moderation queue. Defaults to the pending submissions an admin needs
 * to review; any lifecycle status can be requested for history views.
 */
export const listReviewCoursesQuerySchema = z.object({
  status: z.enum(COURSE_STATUSES).default('pending_review'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COURSE_PAGE_MAX_LIMIT)
    .default(COURSE_PAGE_DEFAULT_LIMIT),
});

export type ListReviewCoursesQuery = z.infer<
  typeof listReviewCoursesQuerySchema
>;

/**
 * A rejection must explain what the teacher needs to fix. The service stores
 * the reason and the owner can read it until the course is resubmitted.
 */
export const rejectCourseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Rejection reason is required')
    .max(
      COURSE_REJECTION_REASON_MAX,
      `Rejection reason cannot exceed ${COURSE_REJECTION_REASON_MAX} characters`,
    ),
});

export type RejectCourseInput = z.infer<typeof rejectCourseSchema>;

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

export const courseIdParamSchema = z.object({
  courseId: objectId('course id'),
});

export const sectionParamSchema = z.object({
  courseId: objectId('course id'),
  sectionId: objectId('section id'),
});

export const lessonParamSchema = z.object({
  courseId: objectId('course id'),
  sectionId: objectId('section id'),
  lessonId: objectId('lesson id'),
});

export type CourseIdParam = z.infer<typeof courseIdParamSchema>;
export type SectionParam = z.infer<typeof sectionParamSchema>;
export type LessonParam = z.infer<typeof lessonParamSchema>;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const createSectionSchema = z.object({
  title: title(SECTION_TITLE_MAX),
  description: description(SECTION_DESCRIPTION_MAX),
});

export type CreateSectionInput = z.infer<typeof createSectionSchema>;

export const updateSectionSchema = z
  .object({
    title: title(SECTION_TITLE_MAX).optional(),
    description: description(SECTION_DESCRIPTION_MAX),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

export const reorderSectionsSchema = z.object({
  sectionIds: z
    .array(objectId('section id'))
    .min(1, 'At least one section id is required'),
});

export type ReorderSectionsInput = z.infer<typeof reorderSectionsSchema>;

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

const lessonBase = {
  title: title(LESSON_TITLE_MAX),
  description: description(LESSON_DESCRIPTION_MAX),
};

/**
 * Creation is a discriminated union so each lesson type only accepts the
 * payload it understands. `quiz` is accepted structurally but rejected by the
 * service until the Quiz System (Phase 10) exists.
 */
export const createLessonSchema = z.discriminatedUnion('type', [
  z.object({
    ...lessonBase,
    type: z.literal('video'),
    videoId: objectId('video id'),
  }),
  z.object({
    ...lessonBase,
    type: z.literal('text'),
    content: z
      .string()
      .trim()
      .min(1, 'Content is required for a text lesson')
      .max(
        LESSON_TEXT_CONTENT_MAX,
        `Content cannot exceed ${LESSON_TEXT_CONTENT_MAX} characters`,
      ),
  }),
  z.object({
    ...lessonBase,
    type: z.literal('document'),
    documentUrl: documentUrlSchema,
    documentName: z
      .string()
      .trim()
      .max(200, 'Document name cannot exceed 200 characters')
      .optional(),
  }),
  z.object({
    ...lessonBase,
    type: z.literal('quiz'),
  }),
]);

export type CreateLessonInput = z.infer<typeof createLessonSchema>;

/**
 * Partial update. Cross-field rules that depend on the lesson's current type
 * (for example, switching `video` → `text`) are enforced in the service where
 * the existing lesson is known.
 */
export const updateLessonSchema = z
  .object({
    title: title(LESSON_TITLE_MAX).optional(),
    description: description(LESSON_DESCRIPTION_MAX),
    type: z.enum(LESSON_TYPES).optional(),
    videoId: objectId('video id').optional(),
    content: z
      .string()
      .trim()
      .min(1, 'Content is required for a text lesson')
      .max(
        LESSON_TEXT_CONTENT_MAX,
        `Content cannot exceed ${LESSON_TEXT_CONTENT_MAX} characters`,
      )
      .optional(),
    documentUrl: documentUrlSchema.optional(),
    documentName: z
      .string()
      .trim()
      .max(200, 'Document name cannot exceed 200 characters')
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateLessonInput = z.infer<typeof updateLessonSchema>;

export const reorderLessonsSchema = z.object({
  lessonIds: z
    .array(objectId('lesson id'))
    .min(1, 'At least one lesson id is required'),
});

export type ReorderLessonsInput = z.infer<typeof reorderLessonsSchema>;
