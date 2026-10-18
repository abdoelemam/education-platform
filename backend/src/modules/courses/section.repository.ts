import { Types } from 'mongoose';
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
  async create(data: CreateSectionData): Promise<SectionDocument> {
    const section = new SectionModel({
      courseId: new Types.ObjectId(data.courseId),
      title: data.title,
      description: data.description,
      order: data.order,
    });

    return section.save();
  }

  async findById(id: string): Promise<SectionDocument | null> {
    return SectionModel.findById(id).exec();
  }

  /**
   * Scope a lookup to its course so a section id from another course is
   * treated as missing rather than silently editable.
   */
  async findByCourseAndId(
    courseId: string,
    sectionId: string,
  ): Promise<SectionDocument | null> {
    return SectionModel.findOne({ _id: sectionId, courseId }).exec();
  }

  async listByCourse(courseId: string): Promise<SectionDocument[]> {
    return SectionModel.find({ courseId })
      .sort({ order: 1, createdAt: 1 })
      .exec();
  }

  async countByCourse(courseId: string): Promise<number> {
    return SectionModel.countDocuments({ courseId }).exec();
  }

  async maxOrder(courseId: string): Promise<number> {
    const last = await SectionModel.findOne({ courseId })
      .sort({ order: -1 })
      .select('order')
      .exec();

    return last?.order ?? 0;
  }

  async updateById(
    id: string,
    update: SectionUpdate,
    unset: string[] = [],
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

    return SectionModel.findByIdAndUpdate(id, updateDoc, { new: true }).exec();
  }

  async deleteById(id: string): Promise<void> {
    await SectionModel.findByIdAndDelete(id).exec();
  }

  async deleteByCourse(courseId: string): Promise<void> {
    await SectionModel.deleteMany({ courseId }).exec();
  }

  /**
   * Persist explicit ordering. Only the `order` field is touched, so
   * concurrent edits to other fields are preserved.
   */
  async updateOrders(courseId: string, entries: OrderEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    await SectionModel.bulkWrite(
      entries.map((entry) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(entry.id), courseId },
          update: { $set: { order: entry.order } },
        },
      })),
    );
  }
}

export const sectionRepository = new SectionRepository();
