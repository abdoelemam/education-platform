import { Types } from 'mongoose';
import { VideoModel } from './video.model.js';
import type { IVideo, VideoDocument } from './video.types.js';

export interface CreateVideoData {
  ownerId: string;
  title: string;
  description?: string;
  provider: string;
}

export type VideoUpdate = Partial<Omit<IVideo, '_id' | 'createdAt' | 'updatedAt'>>;

export interface ListVideosParams {
  ownerId: string;
  skip: number;
  limit: number;
}

export interface ListVideosResult {
  items: VideoDocument[];
  total: number;
}

export class VideoRepository {
  async create(data: CreateVideoData): Promise<VideoDocument> {
    const video = new VideoModel({
      ownerId: new Types.ObjectId(data.ownerId),
      title: data.title,
      description: data.description,
      provider: data.provider,
      uploadStatus: 'not_authorized',
      processingStatus: 'pending',
    });

    return video.save();
  }

  async findById(id: string): Promise<VideoDocument | null> {
    return VideoModel.findById(id).exec();
  }

  async listByOwner(params: ListVideosParams): Promise<ListVideosResult> {
    const filter = { ownerId: new Types.ObjectId(params.ownerId) };

    const [items, total] = await Promise.all([
      VideoModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(params.skip)
        .limit(params.limit)
        .exec(),
      VideoModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * Update a video by id. `undefined` values are stripped; use `unset` to
   * explicitly clear a field.
   */
  async updateById(
    id: string,
    update: VideoUpdate,
    unset: string[] = [],
  ): Promise<VideoDocument | null> {
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

    return VideoModel.findByIdAndUpdate(id, updateDoc, { new: true }).exec();
  }

  async deleteById(id: string): Promise<void> {
    await VideoModel.findByIdAndDelete(id).exec();
  }
}

export const videoRepository = new VideoRepository();
