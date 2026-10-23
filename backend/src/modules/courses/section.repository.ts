import { Types } from 'mongoose';
import {
  activeEditFenceFilter,
  COMMITTED_CONTENT_FILTER,
  type CourseEditFence,
} from './course.fence.js';
import { SectionModel } from './section.model.js';
import type { ISection, SectionDocument } from './course.types.js';

export interface CreateSectionData {
  courseId: string;
  title: string;
  description?: string;
  order: number;
}

export type SectionUpdate = Partial<Pick<ISection, 'title' | 'description'>>;

export interface OrderEntry {
  id: string;
  order: number;
}

export class SectionRepository {
  /**
   * Insert a hidden staged section. It becomes visible only after
   * `commitCreated` succeeds under the same live lease.
   */
  async create(
    data: CreateSectionData,
    fence: CourseEditFence,
  ): Promise<SectionDocument> {
    const section = new SectionModel({
      courseId: new Types.ObjectId(data.courseId),
      title: data.title,
      description: data.description,
      order: data.order,
      editToken: fence.token,
      editLeaseExpiresAt: fence.expiresAt,
      committed: false,
    });

    return section.save();
  }

  async commitCreated(
    id: string,
    fence: CourseEditFence,
  ): Promise<SectionDocument | null> {
    return SectionModel.findOneAndUpdate(
      {
        _id: id,
        committed: false,
        ...activeEditFenceFilter(fence),
      },
      { $set: { committed: true } },
      { new: true },
    ).exec();
  }

  async findById(id: string): Promise<SectionDocument | null> {
    return SectionModel.findOne({
      _id: id,
      ...COMMITTED_CONTENT_FILTER,
    }).exec();
  }

  /**
   * Scope a lookup to its course so a section id from another course is
   * treated as missing rather than silently editable.
   */
  async findByCourseAndId(
    courseId: string,
    sectionId: string,
  ): Promise<SectionDocument | null> {
    return SectionModel.findOne({
      _id: sectionId,
      courseId,
      ...COMMITTED_CONTENT_FILTER,
    }).exec();
  }

  async listByCourse(courseId: string): Promise<SectionDocument[]> {
    return SectionModel.find({
      courseId,
      ...COMMITTED_CONTENT_FILTER,
    })
      .sort({ order: 1, createdAt: 1 })
      .exec();
  }

  async countByCourse(courseId: string): Promise<number> {
    return SectionModel.countDocuments({
      courseId,
      ...COMMITTED_CONTENT_FILTER,
    }).exec();
  }

  /**
   * Count committed sections for several courses in one aggregation. Used by
   * listing endpoints that show a curriculum summary per course.
   */
  async countCommittedByCourseIds(
    courseIds: string[],
  ): Promise<Map<string, number>> {
    if (courseIds.length === 0) {
      return new Map();
    }

    const rows = await SectionModel.aggregate<{
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

  async maxOrder(courseId: string): Promise<number> {
    const last = await SectionModel.findOne({
      courseId,
      ...COMMITTED_CONTENT_FILTER,
    })
      .sort({ order: -1 })
      .select('order')
      .exec();

    return last?.order ?? 0;
  }

  async updateById(
    id: string,
    update: SectionUpdate,
    unset: string[],
    fence: CourseEditFence,
  ): Promise<SectionDocument | null> {
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

    return SectionModel.findOneAndUpdate(
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
    const deleted = await SectionModel.findOneAndDelete({
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
  async deleteByCourse(courseId: string): Promise<void> {
    await SectionModel.deleteMany({ courseId }).exec();
  }

  async deleteStagedByCourse(courseId: string): Promise<void> {
    await SectionModel.deleteMany({
      courseId,
      committed: false,
    }).exec();
  }

  /** All section ids, including staged rows. Used to fence a stale takeover. */
  async listIdsByCourse(courseId: string): Promise<string[]> {
    const sections = await SectionModel.find({ courseId })
      .select('_id')
      .exec();
    return sections.map((section) => section._id.toString());
  }

  async listStagedIdsByCourse(courseId: string): Promise<string[]> {
    const sections = await SectionModel.find({
      courseId,
      committed: false,
    })
      .select('_id')
      .exec();
    return sections.map((section) => section._id.toString());
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
    await SectionModel.deleteMany({
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
   * Move every section's fence to a newly acquired lease. A stale holder's
   * token/expiry can no longer match any document.
   */
  async refreshLease(
    courseId: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    await SectionModel.updateMany(
      { courseId },
      { $set: { editToken: token, editLeaseExpiresAt: expiresAt } },
    ).exec();
  }

  /**
   * Persist explicit ordering. Every document update carries the fence; if any
   * entry no longer matches, the caller reports a stale-lease conflict.
   */
  async updateOrders(
    courseId: string,
    entries: OrderEntry[],
    fence: CourseEditFence,
  ): Promise<boolean> {
    if (entries.length === 0) {
      return true;
    }

    const result = await SectionModel.bulkWrite(
      entries.map((entry) => ({
        updateOne: {
          filter: {
            _id: new Types.ObjectId(entry.id),
            courseId,
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

export const sectionRepository = new SectionRepository();
