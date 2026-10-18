import { Types } from 'mongoose';
import { LessonModel } from './lesson.model.js';
import type { LessonDocument, LessonType } from './course.types.js';

export interface CreateLessonData {
  courseId: string;
  sectionId: string;
  title: string;
  type: LessonType;
  order: number;
  description?: string;
  videoId?: string;
  content?: string;
  documentUrl?: string;
  documentName?: string;
}

/**
 * Partial lesson update. Type-specific payload fields are plain strings; the
 * repository casts `videoId` to an ObjectId when persisting.
 */
export interface LessonUpdate {
  title?: string;
  description?: string;
  type?: LessonType;
  videoId?: string;
  content?: string;
  documentUrl?: string;
  documentName?: string;
}

export interface OrderEntry {
  id: string;
  order: number;
}

export class LessonRepository {
  async create(data: CreateLessonData): Promise<LessonDocument> {
    const lesson = new LessonModel({
      courseId: new Types.ObjectId(data.courseId),
      sectionId: new Types.ObjectId(data.sectionId),
      title: data.title,
      type: data.type,
      order: data.order,
      description: data.description,
      videoId: data.videoId ? new Types.ObjectId(data.videoId) : undefined,
      content: data.content,
      documentUrl: data.documentUrl,
      documentName: data.documentName,
    });

    return lesson.save();
  }

  async findById(id: string): Promise<LessonDocument | null> {
    return LessonModel.findById(id).exec();
  }

  /**
   * Scope a lookup to its section and course so a lesson id from elsewhere is
   * treated as missing.
   */
  async findBySectionAndId(
    courseId: string,
    sectionId: string,
    lessonId: string,
  ): Promise<LessonDocument | null> {
    return LessonModel.findOne({ _id: lessonId, sectionId, courseId }).exec();
  }

  async listByCourse(courseId: string): Promise<LessonDocument[]> {
    return LessonModel.find({ courseId }).sort({ order: 1, createdAt: 1 }).exec();
  }

  async listBySection(sectionId: string): Promise<LessonDocument[]> {
    return LessonModel.find({ sectionId })
      .sort({ order: 1, createdAt: 1 })
      .exec();
  }

  async maxOrder(sectionId: string): Promise<number> {
    const last = await LessonModel.findOne({ sectionId })
      .sort({ order: -1 })
      .select('order')
      .exec();

    return last?.order ?? 0;
  }

  async updateById(
    id: string,
    update: LessonUpdate,
    unset: string[] = [],
  ): Promise<LessonDocument | null> {
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

    return LessonModel.findByIdAndUpdate(id, updateDoc, { new: true }).exec();
  }

  async deleteById(id: string): Promise<void> {
    await LessonModel.findByIdAndDelete(id).exec();
  }

  async deleteBySection(sectionId: string): Promise<void> {
    await LessonModel.deleteMany({ sectionId }).exec();
  }

  async deleteByCourse(courseId: string): Promise<void> {
    await LessonModel.deleteMany({ courseId }).exec();
  }

  /**
   * Persist explicit ordering. Only the `order` field is touched.
   */
  async updateOrders(sectionId: string, entries: OrderEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    await LessonModel.bulkWrite(
      entries.map((entry) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(entry.id), sectionId },
          update: { $set: { order: entry.order } },
        },
      })),
    );
  }
}

export const lessonRepository = new LessonRepository();
