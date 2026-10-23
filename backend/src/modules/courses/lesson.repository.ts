import { Types } from 'mongoose';
import {
  activeEditFenceFilter,
  COMMITTED_CONTENT_FILTER,
  type CourseEditFence,
} from './course.fence.js';
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
  /**
   * Insert a hidden staged lesson. It becomes visible only after
   * `commitCreated` succeeds under the same live lease.
   */
  async create(
    data: CreateLessonData,
    fence: CourseEditFence,
  ): Promise<LessonDocument> {
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
      editToken: fence.token,
      editLeaseExpiresAt: fence.expiresAt,
      committed: false,
    });

    return lesson.save();
  }

  async commitCreated(
    id: string,
    fence: CourseEditFence,
  ): Promise<LessonDocument | null> {
    return LessonModel.findOneAndUpdate(
      {
        _id: id,
        committed: false,
        ...activeEditFenceFilter(fence),
      },
      { $set: { committed: true } },
      { new: true },
    ).exec();
  }

  async findById(id: string): Promise<LessonDocument | null> {
    return LessonModel.findOne({
      _id: id,
      ...COMMITTED_CONTENT_FILTER,
    }).exec();
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
    return LessonModel.findOne({
      _id: lessonId,
      sectionId,
      courseId,
      ...COMMITTED_CONTENT_FILTER,
    }).exec();
  }

  async listByCourse(courseId: string): Promise<LessonDocument[]> {
    return LessonModel.find({
      courseId,
      ...COMMITTED_CONTENT_FILTER,
    })
      .sort({ order: 1, createdAt: 1 })
      .exec();
  }

  /**
   * Count committed lessons for several courses in one aggregation. Used by
   * listing endpoints that show a curriculum summary per course.
   */
  async countCommittedByCourseIds(
    courseIds: string[],
  ): Promise<Map<string, number>> {
    if (courseIds.length === 0) {
      return new Map();
    }

    const rows = await LessonModel.aggregate<{
      _id: Types.ObjectId;
      count: number;
    }>([
      {
        $match: {
          courseId: {
            $in: courseIds.map((id) => new Types.ObjectId(id)),
          },
          ...COMMITTED_CONTENT_FILTER,
        },
      },
      { $group: { _id: '$courseId', count: { $sum: 1 } } },
    ]).exec();

    return new Map(rows.map((row) => [row._id.toString(), row.count]));
  }

  async listBySection(sectionId: string): Promise<LessonDocument[]> {
    return LessonModel.find({
      sectionId,
      ...COMMITTED_CONTENT_FILTER,
    })
      .sort({ order: 1, createdAt: 1 })
      .exec();
  }

  async maxOrder(sectionId: string): Promise<number> {
    const last = await LessonModel.findOne({
      sectionId,
      ...COMMITTED_CONTENT_FILTER,
    })
      .sort({ order: -1 })
      .select('order')
      .exec();

    return last?.order ?? 0;
  }

  async updateById(
    id: string,
    update: LessonUpdate,
    unset: string[],
    fence: CourseEditFence,
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

    return LessonModel.findOneAndUpdate(
      {
        _id: id,
        ...COMMITTED_CONTENT_FILTER,
        ...activeEditFenceFilter(fence),
      },
      updateDoc,
      { new: true },
    ).exec();
  }

  async deleteById(id: string, fence: CourseEditFence): Promise<boolean> {
    const deleted = await LessonModel.findOneAndDelete({
      _id: id,
      ...COMMITTED_CONTENT_FILTER,
      ...activeEditFenceFilter(fence),
    }).exec();

    return deleted !== null;
  }

  /**
   * Unfenced cascade cleanup, used only after the parent course/section delete
   * has already been authorized under a live lease.
   */
  async deleteBySection(sectionId: string): Promise<void> {
    await LessonModel.deleteMany({ sectionId }).exec();
  }

  async deleteByCourse(courseId: string): Promise<void> {
    await LessonModel.deleteMany({ courseId }).exec();
  }

  async deleteStagedByCourse(courseId: string): Promise<void> {
    await LessonModel.deleteMany({
      courseId,
      committed: false,
    }).exec();
  }

  /** All lesson ids, including staged rows. Used to fence a stale takeover. */
  async listIdsByCourse(courseId: string): Promise<string[]> {
    const lessons = await LessonModel.find({ courseId }).select('_id').exec();
    return lessons.map((lesson) => lesson._id.toString());
  }

  async listStagedIdsByCourse(courseId: string): Promise<string[]> {
    const lessons = await LessonModel.find({
      courseId,
      committed: false,
    })
      .select('_id')
      .exec();
    return lessons.map((lesson) => lesson._id.toString());
  }

  /**
   * Remove rows that appeared during a stale takeover. `keepIds` is the set of
   * rows that existed at the takeover snapshot; `stagedIds` is the set that was
   * staged at that snapshot, even if an old holder flipped it to committed
   * before cleanup ran. Everything else in the course is abandoned.
   */
  async removeStaleForTakeover(
    courseId: string,
    keepIds: string[],
    stagedIds: string[],
  ): Promise<void> {
    await LessonModel.deleteMany({
      courseId,
      $or: [
        {
          _id: {
            $nin: keepIds.map((id) => new Types.ObjectId(id)),
          },
        },
        {
          _id: {
            $in: stagedIds.map((id) => new Types.ObjectId(id)),
          },
        },
        { committed: false },
      ],
    }).exec();
  }

  /**
   * Move every lesson's fence to a newly acquired lease. A stale holder's
   * token/expiry can no longer match any document.
   */
  async refreshLease(
    courseId: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    await LessonModel.updateMany(
      { courseId },
      { $set: { editToken: token, editLeaseExpiresAt: expiresAt } },
    ).exec();
  }

  /**
   * Persist explicit ordering. Every document update carries the fence; if any
   * entry no longer matches, the caller reports a stale-lease conflict.
   */
  async updateOrders(
    sectionId: string,
    entries: OrderEntry[],
    fence: CourseEditFence,
  ): Promise<boolean> {
    if (entries.length === 0) {
      return true;
    }

    const result = await LessonModel.bulkWrite(
      entries.map((entry) => ({
        updateOne: {
          filter: {
            _id: new Types.ObjectId(entry.id),
            sectionId,
            ...COMMITTED_CONTENT_FILTER,
            ...activeEditFenceFilter(fence),
          },
          update: { $set: { order: entry.order } },
        },
      })),
    );

    return result.matchedCount === entries.length;
  }
}

export const lessonRepository = new LessonRepository();
