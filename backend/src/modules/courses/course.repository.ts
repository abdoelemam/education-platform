import { Types } from 'mongoose';
import { CourseModel } from './course.model.js';
import type { CourseDocument, CourseStatus, ICourse } from './course.types.js';

export interface CreateCourseData {
  ownerId: string;
  title: string;
  slug: string;
  description?: string;
}

export type CourseUpdate = Partial<
  Omit<ICourse, '_id' | 'createdAt' | 'updatedAt' | 'ownerId' | 'slug'>
>;

export interface ListCoursesParams {
  ownerId: string;
  skip: number;
  limit: number;
}

export interface ListCoursesByStatusParams {
  status: CourseStatus;
  skip: number;
  limit: number;
}

export interface ListCoursesResult {
  items: CourseDocument[];
  total: number;
}

/**
 * Build a MongoDB update document, stripping `undefined` values and turning
 * explicit `unset` keys into `$unset` entries.
 */
function buildUpdateDocument(
  update: CourseUpdate,
  unset: string[],
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) {
      set[key] = value;
    }
  }

  const updateDoc: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) {
    updateDoc.$set = set;
  }
  if (unset.length > 0) {
    updateDoc.$unset = Object.fromEntries(unset.map((key) => [key, 1]));
  }

  return updateDoc;
}

export class CourseRepository {
  async create(data: CreateCourseData): Promise<CourseDocument> {
    const course = new CourseModel({
      ownerId: new Types.ObjectId(data.ownerId),
      title: data.title,
      slug: data.slug,
      description: data.description,
      status: 'draft',
    });

    return course.save();
  }

  async findById(id: string): Promise<CourseDocument | null> {
    return CourseModel.findById(id).exec();
  }

  async listByOwner(params: ListCoursesParams): Promise<ListCoursesResult> {
    const filter = { ownerId: new Types.ObjectId(params.ownerId) };

    const [items, total] = await Promise.all([
      CourseModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(params.skip)
        .limit(params.limit)
        .exec(),
      CourseModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * List courses in a given lifecycle status (newest first). Used by the admin
   * moderation queue.
   */
  async listByStatus(
    params: ListCoursesByStatusParams,
  ): Promise<ListCoursesResult> {
    const filter = { status: params.status };

    const [items, total] = await Promise.all([
      CourseModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(params.skip)
        .limit(params.limit)
        .exec(),
      CourseModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * Update course metadata. `undefined` values are stripped; use `unset` to
   * explicitly clear a field.
   */
  async updateById(
    id: string,
    update: CourseUpdate,
    unset: string[] = [],
  ): Promise<CourseDocument | null> {
    return CourseModel.findByIdAndUpdate(
      id,
      buildUpdateDocument(update, unset),
      { new: true },
    ).exec();
  }

  /**
   * Compare-and-set a lifecycle transition.
   *
   * The update only succeeds while the stored status is still one of
   * `fromStatuses`. This prevents two concurrent reviewers (or a reviewer and
   * the owner) from both acting on the same submission; the loser receives
   * `null` and the service reports a conflict.
   */
  async transitionStatus(
    id: string,
    fromStatuses: readonly CourseStatus[],
    update: CourseUpdate,
    unset: string[] = [],
  ): Promise<CourseDocument | null> {
    return CourseModel.findOneAndUpdate(
      { _id: id, status: { $in: [...fromStatuses] } },
      buildUpdateDocument(update, unset),
      { new: true },
    ).exec();
  }

  async deleteById(id: string): Promise<void> {
    await CourseModel.findByIdAndDelete(id).exec();
  }
}

export const courseRepository = new CourseRepository();
