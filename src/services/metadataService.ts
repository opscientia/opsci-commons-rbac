import * as express from "express";
import axios from "axios";
import fse from "fs-extra";
import mongodb from "mongodb";
import web3 from "web3";
import { ethers } from "ethers";
import { packToFs } from "ipfs-car/pack/fs";
import { FsBlockStore } from "ipfs-car/blockstore/fs";
import { unpackToFs } from "ipfs-car/unpack/fs";
import sanitizeHtml from "sanitize-html";
import dbWrapper from "../utils/dbWrapper";
import estuaryWrapper from "../utils/estuaryWrapper";
import utils from "../utils/utils";
import { fetchJson } from "ethers/lib/utils";
import { TypeOf } from "yup";

/**
 * Get dataset metadata for every dataset belonging to the specified address.
 * (Does not require authentication.)
 */
export async function getDatasetMetadata (req: any, res: any){
  if (!req.query.address) {
    const message =
      "Please specify the dataset uploader with the address query parameter";
    return res.status(400).json({ error: message });
  }
  const address = req.query.address.toLowerCase();

  try {
    const datasets = await dbWrapper.getDatasets({ uploader: address });
    return res.status(200).json(datasets);
  } catch (err) {
    console.log(err);
  }
  return res
    .status(404)
    .json({ error: "No datasets for the specified address" });
};



/**
 * Get dataset metadata for every published dataset.
 * (Does not require authentication.)
 */
export async function getAllPublishedDatasets(req: any, res: any){
  console.log(`${new Date().toISOString()} getAllPublishedDatasets: entered`);
  try {
    const datasets = await dbWrapper.getDatasets({ published: true });
    return res.status(200).json(datasets);
  } catch (err) {
    console.log(err);
  }
  return res.status(404).json({ error: "There are no published datasets" });
};


export async function getPublishedDatasetById(req: any, res: any){
  console.log(`${new Date().toISOString()} getPublishedDatasetById: entered`);
  if (!req.query.id) {
    const message = "Please specify the dataset ID via the id query parameter";
    return res.status(404).json({ error: message });
  }
  try {
    const query = { _id: new mongodb.ObjectId(req.query.id), published: true };
    const datasets = await dbWrapper.getDatasets(query);
    if (datasets?.length > 0) {
      return res.status(200).json(datasets[0]);
    }
  } catch (err) {
    console.log(err);
  }
  const message = "There is no published dataset with the specified id";
  return res.status(404).json({ error: message });
};

export async function getPublishedDatasets(req: any, res: any) {
  if (req.query.id) {
    return await getPublishedDatasetById(req, res);
  } else {
    return await getAllPublishedDatasets(req, res);
  }
};

export async function getPublishedDatasetsByUploader(req: any, res: any){
  console.log(
    `${new Date().toISOString()} getPublishedDatasetsByUploader: entered`
  );
  if (!req.query.uploader) {
    const msg = "Please dataset uploader with the uploader query parameter";
    return res.status(400).json({ error: msg });
  }
  const uploader = req.query.uploader.toLowerCase();
  try {
    // Get dataset first to ensure datasetId refers to a published dataset
    const dsQuery = { uploader: uploader, published: true };
    const datasets = await dbWrapper.getDatasets(dsQuery);
    if (datasets.length > 0) {
      return res.status(200).json(datasets);
    }
  } catch (err) {
    console.log(err);
  }
  const msg = `Found no datasets whose uploader is ${uploader}`;
  return res.status(404).json({ error: msg });
};

export async function searchPublishedDatasets(req: any, res: any) {
  console.log(`${new Date().toISOString()} searchPublishedDatasets: entered`);
  const searchStr = req.query.searchStr;
  if (!searchStr) {
    const message =
      "Please provide a search string via the searchStr query parameter";
    return res.status(400).json({ error: message });
  }
  try {
    const query = {
      published: true,
      $text: {
        $search: searchStr,
      },
    };
    const datasets = await dbWrapper.getDatasets(query);
    return res.status(200).json(datasets);
  } catch (err) {
    console.log(err);
  }
  return res.status(404).json({ error: "No published datasets found" });
};

/**
 * On the dataset specified by the provided datasetId, set published to true.
 * body params: address, signature, datasetId, title, description, authors, keywords
 */
export async function publishDataset (req: any, res: any){
  console.log(`${new Date().toISOString()} publishDataset: entered`);
  const address = sanitizeHtml(req.body.address?.toLowerCase());
  const signature = sanitizeHtml(req.body.signature);
  const datasetId = sanitizeHtml(req.body.datasetId);
  const title = sanitizeHtml(req.body.title);
  const description = sanitizeHtml(req.body.description);
  const authorsStrArr = req.body.authors
    ?.split(",")
    ?.map((author: string) => sanitizeHtml(author));
  const keywords = req.body.keywords
    ?.split(",")
    ?.map((keyword: string) => sanitizeHtml(keyword));
  if (
    !address ||
    !signature ||
    !datasetId ||
    !title ||
    !description ||
    !authorsStrArr
  ) {
    console.log(
      `${new Date().toISOString()} publishDataset: parameter(s) not provided`
    );
    console.log(
      `parameters: [${address}, ${signature}, ${datasetId}, ${title}, ${description}, ${authorsStrArr}]`
    );
    return res
      .status(400)
      .json({ error: "Failed to publish dataset. Missing parameters." });
  }

  // Check signature
  const msg = `${req.body.address}${datasetId}`;
  const authSuccess = utils.assertSignerIsAddress(msg, signature, address);
  if (!authSuccess) {
    console.log(`signer != address`);
    return res
      .status(400)
      .json({ error: "Failed to publish dataset. Signer != address" });
  }

  // TODO!! -- Find a way to check that an author has not already been added. Perhaps require ORCID
  const authorIds: mongodb.ObjectId[] = [];
  const authors = authorsStrArr.map((authorStr: any) => {
    const authorId = new mongodb.ObjectId();
    authorIds.push(authorId);
    return {
      _id: authorId,
      name: authorStr,
    };
  });
  for (const author of authors) {
    if (!(await dbWrapper.insertAuthor(author))) {
      return res
        .status(400)
        .json({ error: "Failed to insert author into database" });
    }
  }
  let success = false;
  try {
    const query = { uploader: address, _id: new mongodb.ObjectId(datasetId) };
    const updateDocument = {
      $set: {
        published: true,
        title: title,
        description: description,
        authors: authorIds,
        keywords: keywords,
      },
    };
    for (let i = 0; i < 3; i++) {
      success = await dbWrapper.updateDataset(query, updateDocument);
      if (success) {
        console.log(
          `publisDataset: successfully published dataset ${datasetId} for ${address}`
        );
        const message = `Successfully published dataset ${datasetId} for ${address}`;
        return res.status(200).json({ message: message });
      }
    }
  } catch (err) {
    console.log(err);
  }
  console.log(
    `${new Date().toISOString()} publishDataset: failed to publish dataset ${datasetId} for ${address}`
  );
  return res.status(400).json({ error: "Failed to publish dataset." });
};

// Get a dataset's child chunks
export async function getPublishedChunksByDatasetId(req: any, res: any){
  console.log(
    `${new Date().toISOString()} getPublishedChunksByDatasetId: entered`
  );
  if (!req.query.datasetId) {
    const msg =
      "Please specify the chunk's parent dataset with the datasetId query parameter";
    return res.status(400).json({ error: msg });
  }
  try {
    // Get dataset first to ensure datasetId refers to a published dataset
    const dsQuery = {
      _id: new mongodb.ObjectId(req.query.datasetId),
      published: true,
    };
    const datasets = await dbWrapper.getDatasets(dsQuery);
    if (datasets.length > 0) {
      const chunksQuery = { datasetId: new mongodb.ObjectId(req.query.datasetId) };
      const chunks = await dbWrapper.getChunks(chunksQuery);
      return res.status(200).json(chunks);
    }
  } catch (err) {
    console.log(err);
  }
  const msg = `Found no chunks whose parent dataset is ${req.query.datasetId}`;
  return res.status(404).json({ error: msg });
};

/**
 * Get file metadata for every file belonging to the specified address.
 * (Does not require authentication. Only modifications to a user's files require authentication.)
 */
export async function getFileMetadata(req: any, res: any){
  console.log(`${new Date().toISOString()} getFileMetadata: entered`);
  if (!req.query.address) {
    const message =
      "Please specify the uploader with the address query parameter";
    return res.status(400).json({ error: message });
  }
  const address = req.query.address.toLowerCase();

  try {
    const datasets = await dbWrapper.getDatasets({ uploader: address });
    const chunkIds = [];
    for (const dataset of datasets) {
      chunkIds.push(...dataset.chunkIds);
    }
    const chunksQuery = {
      _id: {
        $in: chunkIds,
      },
    };
    
    const chunks = await dbWrapper.getChunks(chunksQuery);
    const fileIdToEstuaryId = {};
    let fileIds: string[] = [];
    for (const chunk of chunks) {
      for (const fileId of chunk.fileIds) {
        // @ts-expect-error
        fileIdToEstuaryId[fileId] = chunk.storageIds.estuaryId;
        fileIds.push(fileId);
      }
    }
    const filesQuery = {
      _id: {
        $in: fileIds,
      },
    };
    const files = await dbWrapper.getCommonsFiles(filesQuery);
    const filesWithEstIds = files.map((file: any) => ({
      ...file,
      // TODO: There must be a better way to return the estuaryIds of the datasets
      // @ts-expect-error 
      estuaryId: fileIdToEstuaryId[file._id],
    }));
    return res.status(200).json(filesWithEstIds);
  } catch (err) {
    console.log(err);
  }
  return res.status(400).json({ error: "No files for the specified address" });
};

/**
 * Delete file by address && estuaryId.
 * If path is specified, only the file designated by path is deleted. If path is not specified,
 * the entire CAR file designated by estuaryId is deleted.
 */
export async function deleteFileMetadata  (req: any , res: any): Promise<any> {
  console.log(`${new Date().toISOString()} deleteFileMetadata: Entered`);
  if (!req.query.address || !req.query.estuaryId || !req.query.signature) {
    return res.status(400).json({ error: "Missing parameter(s)" });
  }
  if (
    req.query.address.length != 42 ||
    req.query.address.substring(0, 2) != "0x"
  ) {
    const message =
      "Address must start with 0x and be less than 42 characters long";
    return res.status(400).json({ error: message });
  }
  const address = req.query.address.toLowerCase();
  const estuaryId = parseInt(req.query.estuaryId);
  const path = req.query.path;
  const signature = req.query.signature;

  // Ensure signer == address == address associated with this estuaryId
  const msg = `/metadata/files?address=${req.query.address}&estuaryId=${estuaryId}`;
  const authSuccess = utils.assertSignerIsAddress(msg, signature, address);
  if (!authSuccess) {
    console.log(`signer != address`);
    return res
      .status(400)
      .json({ error: "Failed to delete file metadata. Signer != address" });
  }
  // TODO: Allow deletion of single files
  // Delete entire dataset
  const chunks = await dbWrapper.getChunks({
    "storageIds.estuaryId": estuaryId,
  });
  if (!chunks || chunks.length == 0) {
    const message =
      "Failed to delete file metadata. No corresponding chunks found.";
    return res.status(404).json({ error: message });
  }
  const datasetId = chunks[0].datasetId;
  const datasets = await dbWrapper.getDatasets({ _id: datasetId });
  if (!datasets || datasets.length == 0) {
    const message =
      "Failed to delete file metadata. No corresponding datasets found.";
    return res.status(404).json({ error: message });
  }
  const dataset = datasets[0];
  if (dataset.published) {
    console.log(
      `${new Date().toISOString()} deleteFileMetadata: Trying to delete published dataset. Exiting.`
    );
    return res.status(400).json({ error: "Cannot delete published dataset" });
  }
  const datasetChildChunkIds = dataset.chunkIds;
  let successfulDelete = await dbWrapper.deleteCommonsFiles({
    chunkId: { $in: datasetChildChunkIds },
  });
  // TODO: Check successfulDelete
  successfulDelete = await dbWrapper.deleteChunks({
    _id: { $in: datasetChildChunkIds },
  });
  // TODO: Check successfulDelete
  successfulDelete = await dbWrapper.deleteDataset({ _id: datasetId });
  // TODO: Check successfulDelete
  successfulDelete = await estuaryWrapper.deleteFile(estuaryId, 5);
  if (successfulDelete) {
    const message = `Successfully deleted file metadata for file with estuaryId: ${estuaryId}`;
    return res.status(200).json({ data: message });
  }
  return res
    .status(400)
    .json({ error: "An unknown error occurred. Failed to delete dataset." });
};

export async function getAuthorsByDatasetId(req:any, res:any){
  console.log(`${new Date().toISOString()} getAuthorsByDatasetId: entered`);
  if (!req.query.datasetId) {
    const message =
      "Please specify the dataset ID via the datasetId query parameter";
    return res.status(404).json({ error: message });
  }
  try {
    const query = {
      _id: new mongodb.ObjectId(req.query.datasetId),
      published: true,
    };
    const datasets = await dbWrapper.getDatasets(query);
    if (datasets?.length > 0) {
      const authorIds = datasets[0].authors.map((idStr : any) =>
        new mongodb.ObjectId(idStr)
      );
      const authorsQuery = { _id: { $in: authorIds } };
      const authors = await dbWrapper.getAuthors(authorsQuery);
      if (authors.length > 0) {
        return res.status(200).json(authors);
      }
    }
  } catch (err) {
    console.log(err);
  }
  const message = "There are no authors for the specified dataset";
  return res.status(400).json({ error: message });
};

export default {
  getDatasetMetadata,
  getPublishedDatasets,
  getPublishedDatasetsByUploader,
  searchPublishedDatasets,
  publishDataset,
  getPublishedChunksByDatasetId,
  getFileMetadata,
  deleteFileMetadata,
  getAuthorsByDatasetId,
};
