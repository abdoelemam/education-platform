import { Types } from 'mongoose';
import { CourseModel } from './course.model.js';
import type { CourseDocument, ICourse } from './course.types.js';

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

export interface ListCoursesResult {
  items: CourseDocument[];
  total: number;
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
   * Update course metadata. `undefined` values are stripped; use `unset` to
   * explicitly clear a field.
   */
  async updateById(
    id: string,
    update: CourseUpdate,
    unset: string[] = [],
  ): Promise<CourseDocument | null> {
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

    return CourseModel.findByIdAndUpdate(id, updateDoc, { new: true }).exec();
  }

  async deleteById(id: string): Promise<void> {
    await CourseModel.findByIdAndDelete(id).exec();
  }
}

export const courseRepository = new CourseRepository();
