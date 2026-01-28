
export interface HeapItem {
  key: number; // Packed integer coordinate
  fScore: number;
}

export class MinHeap {
  private items: HeapItem[] = [];

  push(key: number, fScore: number) {
    this.items.push({ key, fScore });
    this.bubbleUp(this.items.length - 1);
  }

  pop(): HeapItem | undefined {
    if (this.items.length === 0) return undefined;
    const root = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return root;
  }

  size(): number {
    return this.items.length;
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.items[index].fScore >= this.items[parentIndex].fScore) break;
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private bubbleDown(index: number) {
    const length = this.items.length;
    const element = this.items[index];

    while (true) {
      let leftChildIndex = 2 * index + 1;
      let rightChildIndex = 2 * index + 2;
      let leftChild, rightChild;
      let swap = null;

      if (leftChildIndex < length) {
        leftChild = this.items[leftChildIndex];
        if (leftChild.fScore < element.fScore) {
          swap = leftChildIndex;
        }
      }

      if (rightChildIndex < length) {
        rightChild = this.items[rightChildIndex];
        if (
          (swap === null && rightChild.fScore < element.fScore) ||
          (swap !== null && rightChild.fScore < leftChild!.fScore)
        ) {
          swap = rightChildIndex;
        }
      }

      if (swap === null) break;
      this.swap(index, swap);
      index = swap;
    }
  }

  private swap(i: number, j: number) {
    const temp = this.items[i];
    this.items[i] = this.items[j];
    this.items[j] = temp;
  }
}
