// macOS project writer. The host must verify and package this helper before use.
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/acl.h>
#include <sys/xattr.h>
#include <copyfile.h>
#include <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include <dirent.h>

#ifdef ARYA_PERSISTENCE_TESTING
#define TEST_HOOKS "true"
#else
#define TEST_HOOKS "false"
#endif

#define MAX_DATA (64ULL * 1024 * 1024)
#define MAX_METADATA (4ULL * 1024 * 1024)
static const char *stage = "input";
static int rootfd = -1, oldfd = -1, tempfd = -1, reelfd = -1, recoveryfd = -1, lockfd = -1, draftfd = -1, draftstagefd = -1;
static char tempname[96];
static char draftstagename[64];
static struct stat draftstagestat;
static int draftstagecreated = 0;
static int created = 0, published = 0;
static struct stat tempstat;
static struct stat reelstat, recoverystat, lockstat, draftstat;

// macOS marks documents in iCloud-synced folders with UF_TRACKED for document-ID tracking, and it can
// mark a file this helper just created. It changes no access rights, so it is the one flag allowed.
static int unsupported_flags(const struct stat *info) { return (info->st_flags & ~(uint32_t)UF_TRACKED) != 0; }
static int same_inode(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int unchanged(const struct stat *a, const struct stat *b) {
    return same_inode(a,b) && a->st_size == b->st_size && a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid && a->st_flags == b->st_flags &&
      a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
      a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
static void cleanup(void) {
    if (draftstagecreated && draftfd >= 0) {
        struct stat actual;
        if (fstatat(draftfd,draftstagename,&actual,AT_SYMLINK_NOFOLLOW)==0 && S_ISREG(actual.st_mode) && same_inode(&actual,&draftstagestat)) unlinkat(draftfd,draftstagename,0);
    }
    if (draftstagefd >= 0) close(draftstagefd);
    if (created && !published && rootfd >= 0) {
        struct stat actual;
        if (fstatat(rootfd,tempname,&actual,AT_SYMLINK_NOFOLLOW)==0 && same_inode(&actual,&tempstat)) unlinkat(rootfd,tempname,0);
    }
    if (tempfd >= 0) close(tempfd);
    if (oldfd >= 0) close(oldfd);
    if (draftfd >= 0) close(draftfd);
    if (lockfd >= 0) close(lockfd);
    if (recoveryfd >= 0) close(recoveryfd);
    if (reelfd >= 0) close(reelfd);
    if (rootfd >= 0) close(rootfd);
}
static void fail(void) {
    int code = errno ? errno : EINVAL;
    cleanup();
    fprintf(stdout,"{\"ok\":false,\"stage\":\"%s\",\"errno\":%d}\n",stage,code);
    exit(1);
}
static void require(int condition) { if (!condition) { errno=EINVAL; fail(); } }
static int lock_directory(int parent,const char *name,struct stat *retained) {
    if(mkdirat(parent,name,0700)<0 && errno!=EEXIST)fail();
    int fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)fail();
    if(fstat(fd,retained)<0)fail();require(S_ISDIR(retained->st_mode) && retained->st_uid==geteuid());return fd;
}
static void verify_publication_lock(void) {
    struct stat named,current;
    if(fstatat(rootfd,".reel",&named,AT_SYMLINK_NOFOLLOW)<0)fail();require(S_ISDIR(named.st_mode) && same_inode(&named,&reelstat));
    if(fstatat(reelfd,"recovery",&named,AT_SYMLINK_NOFOLLOW)<0)fail();require(S_ISDIR(named.st_mode) && same_inode(&named,&recoverystat));
    if(fstatat(recoveryfd,"project-write.lock",&named,AT_SYMLINK_NOFOLLOW)<0 || fstat(lockfd,&current)<0)fail();
    require(S_ISREG(named.st_mode) && named.st_nlink==1 && current.st_nlink==1 && named.st_size==0 && current.st_size==0 && same_inode(&named,&lockstat) && same_inode(&current,&lockstat));
}
static void verify_directory_privacy(int directory) {
    acl_t acl=acl_get_fd_np(directory,ACL_TYPE_EXTENDED);
    if(!acl && errno==ENOENT)return;
    if(!acl)fail();
    acl_t empty=acl_init(0);if(!empty)fail();
    ssize_t actual_length=0,empty_length=0;
    char *actual=acl_to_text(acl,&actual_length),*expected=acl_to_text(empty,&empty_length);
    require(actual && expected && actual_length>=0 && empty_length>=0 && (uint64_t)actual_length<=MAX_METADATA && (uint64_t)empty_length<=MAX_METADATA);
    int equal=actual_length==empty_length && memcmp(actual,expected,(size_t)actual_length)==0;
    acl_free(actual);acl_free(expected);acl_free(acl);acl_free(empty);require(equal);
}
static void create_private_draft_stage(void) {
    // Reserve both the empty stage and its eventual final name before allocation.
    int scanfd=dup(draftfd);if(scanfd<0)fail();DIR *entries=fdopendir(scanfd);if(!entries){close(scanfd);fail();}
    unsigned int count=0;struct dirent *entry;errno=0;
    while((entry=readdir(entries))) {if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;if(++count>62){closedir(entries);errno=ENOSPC;fail();}}
    int scan_error=errno;closedir(entries);if(scan_error){errno=scan_error;fail();}
    unsigned char random[16];arc4random_buf(random,sizeof(random));char hex[33];for(int i=0;i<16;i++)sprintf(hex+i*2,"%02x",random[i]);
    snprintf(draftstagename,sizeof(draftstagename),"draft-%s.part",hex);
    draftstagefd=openat(draftfd,draftstagename,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC,0600);if(draftstagefd<0)fail();
    if(fstat(draftstagefd,&draftstagestat)<0)fail();draftstagecreated=1;
    // Inherited access is removed before any transcript bytes enter the file.
    acl_t empty=acl_init(0);if(!empty || acl_set_fd_np(draftstagefd,empty,ACL_TYPE_EXTENDED)<0)fail();acl_free(empty);
    if(fchmod(draftstagefd,0600)<0 || fsync(draftstagefd)<0 || fstat(draftstagefd,&draftstagestat)<0)fail();
    require(S_ISREG(draftstagestat.st_mode) && draftstagestat.st_size==0 && draftstagestat.st_nlink==1 && draftstagestat.st_uid==geteuid() && (draftstagestat.st_mode & 07777)==0600);
    verify_directory_privacy(draftstagefd);
    if(fsync(draftfd)<0)fail();
}
static void acquire_publication_lock(int journal) {
    stage="lock";
    reelfd=lock_directory(rootfd,".reel",&reelstat);recoveryfd=lock_directory(reelfd,"recovery",&recoverystat);
    if(journal)verify_directory_privacy(recoveryfd);
    lockfd=openat(recoveryfd,"project-write.lock",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC,0600);
    if(lockfd>=0) {acl_t empty=acl_init(0);if(!empty || acl_set_fd_np(lockfd,empty,ACL_TYPE_EXTENDED)<0)fail();acl_free(empty);if(fchmod(lockfd,0600)<0 || fsync(lockfd)<0)fail();}
    else if(errno==EEXIST)lockfd=openat(recoveryfd,"project-write.lock",O_RDWR|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    if(lockfd<0)fail();
    if(fstat(lockfd,&lockstat)<0)fail();require(S_ISREG(lockstat.st_mode) && lockstat.st_nlink==1 && lockstat.st_size==0 && lockstat.st_uid==geteuid());
    if(flock(lockfd,LOCK_EX|LOCK_NB)<0)fail();verify_publication_lock();
    if(fsync(recoveryfd)<0 || fsync(reelfd)<0 || fsync(rootfd)<0)fail();
}
static void read_exact(int fd, void *buffer, size_t size) {
    size_t pos=0;
    while(pos<size) { ssize_t n=read(fd,(char*)buffer+pos,size-pos); if(n<0 && errno==EINTR)continue; if(n<=0)fail(); pos+=(size_t)n; }
}
static uint64_t read_u64(void) {
    unsigned char b[8]; read_exact(STDIN_FILENO,b,8); uint64_t n=0;
    for(int i=0;i<8;i++) n=(n<<8)|b[i]; return n;
}
static void write_exact(int fd,const void *buffer,size_t size) {
    size_t pos=0;
    while(pos<size) { ssize_t n=write(fd,(const char*)buffer+pos,size-pos); if(n<0 && errno==EINTR)continue; if(n<=0)fail(); pos+=(size_t)n; }
}
static int select_root(const char *name) {
    require(name[0]=='/' && strlen(name)<PATH_MAX);
    char *copy=strdup(name); if(!copy)fail();
    int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if(fd<0)fail();
    char *save=NULL;
    for(char *part=strtok_r(copy,"/",&save);part;part=strtok_r(NULL,"/",&save)) {
        require(strcmp(part,".")!=0 && strcmp(part,"..")!=0);
        int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        if(next<0){close(fd);fail();} close(fd);fd=next;
    }
    free(copy);return fd;
}
static char *acl_text(int fd, acl_t *retained) {
    acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED); if(!acl && errno==ENOENT)acl=acl_init(0); if(!acl)fail();
    ssize_t length=0; char *text=acl_to_text(acl,&length);
    if(!text || length<0 || (uint64_t)length>MAX_METADATA){acl_free(acl);fail();}
    if(retained)*retained=acl;else acl_free(acl);return text;
}
static void verify_acl(int fd,const char *expected) {
    char *actual=acl_text(fd,NULL);int equal=strcmp(actual,expected)==0;acl_free(actual);require(equal);
}
static char *attribute_names(int fd,ssize_t *length) {
    *length=flistxattr(fd,NULL,0,0);if(*length<0 || (uint64_t)*length>MAX_METADATA)fail();
    char *names=calloc((size_t)*length+1,1);if(!names)fail();
    if(*length && flistxattr(fd,names,(size_t)*length,0)!=*length)fail();return names;
}
// macOS may regenerate the quarantine creator and timestamp for a new file.
// Keep the kernel's marker. Require identical flags and event identity, a valid
// bounded representation, and no timestamp rollback. Other attributes stay exact.
static int quarantine_restrictions_preserved(const void *original, size_t size, const void *staged, size_t other) {
    const unsigned char *a = original, *b = staged;
    if (size < 15 || other < 15 || size > 4096 || other > 4096 ||
        a[4] != ';' || b[4] != ';' || a[13] != ';' || b[13] != ';' ||
        memcmp(a, b, 5) || memchr(a, 0, size) || memchr(b, 0, other)) return 0;
    const unsigned char *ae = memchr(a + 14, ';', size - 14), *be = memchr(b + 14, ';', other - 14);
    if (!ae || !be || size - (size_t)(ae - a) != other - (size_t)(be - b) ||
        memcmp(ae, be, size - (size_t)(ae - a))) return 0;
    uint32_t before = 0, after = 0;
    for (size_t i = 0; i < 13; i++) {
        if (i == 4) continue;
        unsigned int x = a[i], y = b[i];
        x = x >= '0' && x <= '9' ? x - '0' : x >= 'a' && x <= 'f' ? x - 'a' + 10 : x >= 'A' && x <= 'F' ? x - 'A' + 10 : 16;
        y = y >= '0' && y <= '9' ? y - '0' : y >= 'a' && y <= 'f' ? y - 'a' + 10 : y >= 'A' && y <= 'F' ? y - 'A' + 10 : 16;
        if (x > 15 || y > 15) return 0;
        if (i > 4) { before = (before << 4) | x; after = (after << 4) | y; }
    }
    return after >= before;
}
static void verify_xattrs(int from,int to) {
    ssize_t an=0,bn=0;char *a=attribute_names(from,&an),*b=attribute_names(to,&bn);
    size_t ac=0,bc=0,total=0;
    for(size_t p=0;p<(size_t)bn;) {
        size_t n=strnlen(b+p,(size_t)bn-p);require(n<(size_t)bn-p);
        // Keep quarantine added to the new stage by App Sandbox. Existing source
        // quarantine restrictions still participate in the comparison below.
        if(!strcmp(b+p,"com.apple.quarantine")) {
            ssize_t original=fgetxattr(from,b+p,NULL,0,0,0);require(original>=0 || errno==ENOATTR);
            if(original<0) {
                ssize_t added=fgetxattr(to,b+p,NULL,0,0,0);require(added>=0 && (uint64_t)added<=MAX_METADATA);
                total+=(size_t)added;p+=n+1;continue;
            }
        }
        bc++;p+=n+1;
    }
    for(size_t p=0;p<(size_t)an;) {
        size_t n=strnlen(a+p,(size_t)an-p);require(n<(size_t)an-p);const char *name=a+p;
        require(strcmp(name,"com.apple.decmpfs")!=0);
        ssize_t size=fgetxattr(from,name,NULL,0,0,0),other=fgetxattr(to,name,NULL,0,0,0);
        require(size>=0 && other>=0 && (uint64_t)size<=MAX_METADATA && (uint64_t)other<=MAX_METADATA);
        require(other==size || !strcmp(name,"com.apple.quarantine"));
        size_t budget=(size_t)(size>other?size:other);require(total+budget<=MAX_METADATA);total+=budget;
        void *x=malloc((size_t)size+1),*y=malloc((size_t)other+1);if(!x || !y)fail();
        require(fgetxattr(from,name,x,(size_t)size,0,0)==size && fgetxattr(to,name,y,(size_t)other,0,0)==other);
        require((size==other && memcmp(x,y,(size_t)size)==0) || (!strcmp(name,"com.apple.quarantine") && quarantine_restrictions_preserved(x,(size_t)size,y,(size_t)other)));
        free(x);free(y);ac++;p+=n+1;
    }
    free(a);free(b);require(ac==bc);
}
static void verify_expected(int fd,const void *expected,size_t size) {
    struct stat st;if(fstat(fd,&st)<0)fail();require(st.st_size>=0 && (uint64_t)st.st_size==size);
    unsigned char buffer[65536];size_t position=0;
    while(position<size) {size_t count=size-position;if(count>sizeof(buffer))count=sizeof(buffer);ssize_t n=pread(fd,buffer,count,(off_t)position);if(n<0 && errno==EINTR)continue;require(n>0 && memcmp(buffer,(const char*)expected+position,(size_t)n)==0);position+=(size_t)n;}
}
#ifdef ARYA_PERSISTENCE_TESTING
static const char *fault=NULL;
static void test_hook(const char *point) {
    if(fault && ((strcmp(fault,"lock-hold")==0 && strcmp(point,"lock-acquired")==0) || (strcmp(fault,"draft-stage-hold")==0 && strcmp(point,"draft-stage-ready")==0))) {
        const char *ready=getenv("ARYA_TEST_LOCK_READY"),*release=getenv("ARYA_TEST_LOCK_RELEASE");require(ready && release);
        int fd=open(ready,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(fd<0)fail();write_exact(fd,"ready",5);close(fd);
        int attempts=0;while(access(release,F_OK)<0 && attempts++<500)usleep(10000);require(attempts<=500);
    }
    if(fault && strcmp(point,"file-flush")==0) {
        if(strcmp(fault,"temp-byte-swap")==0) {char changed='X';if(pwrite(tempfd,&changed,1,0)!=1)fail();}
        if(strcmp(fault,"temp-append")==0) {if(lseek(tempfd,0,SEEK_END)<0)fail();write_exact(tempfd,"X",1);}
        if(strcmp(fault,"temp-mode-swap")==0 && fchmod(tempfd,0000)<0)fail();
        if(strcmp(fault,"temp-link")==0 && linkat(rootfd,tempname,rootfd,"fixture-temp-link",0)<0)fail();
    }
    if(fault && strcmp(fault,point)==0) _exit(73);
    if(fault && strcmp(fault,"metadata-failure")==0 && strcmp(point,"metadata")==0){errno=EIO;fail();}
    if(fault && strcmp(fault,"quarantine-after-copy")==0 && strcmp(point,"metadata-copied")==0) {
        const char quarantine[]="0082;6ad1b4b7;Arya;";
        if(fsetxattr(tempfd,"com.apple.quarantine",quarantine,sizeof(quarantine)-1,0,0)<0)fail();
    }
    if(fault && (strcmp(fault,"stage-quarantine")==0 || strcmp(fault,"stage-quarantine-later")==0) && strcmp(point,"metadata")==0) {
        const char *quarantine=strcmp(fault,"stage-quarantine-later")==0 ? "0082;6ad1b4b7;Arya;" : "0081;00000000;Arya;";
        if(fsetxattr(tempfd,"com.apple.quarantine",quarantine,strlen(quarantine),0,0)<0)fail();
    }
    if(fault && (strcmp(fault,"ancestor-swap")==0 || strcmp(fault,"ancestor-swap-failure")==0) && strcmp(point,"rename")==0) {
        const char *root=getenv("ARYA_TEST_ROOT"),*moved=getenv("ARYA_TEST_MOVED"),*outside=getenv("ARYA_TEST_OUTSIDE");
        require(root && moved && outside);if(rename(root,moved)<0 || symlink(outside,root)<0)fail();
        if(strcmp(fault,"ancestor-swap-failure")==0) {
            int outsidefd=open(outside,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(outsidefd<0)fail();
            int sentinel=openat(outsidefd,tempname,O_WRONLY|O_CREAT|O_EXCL,0600);if(sentinel<0)fail();
            write_exact(sentinel,"outside-temp",12);close(sentinel);close(outsidefd);errno=EIO;fail();
        }
    }
}
#else
static void test_hook(const char *point) { (void)point; }
#endif
int main(int argc,char **argv) {
    if(argc==2 && strcmp(argv[1],"info")==0) {fprintf(stdout,"{\"ok\":true,\"protocol\":1,\"testHooks\":%s,\"platform\":\"darwin\",\"metadata\":\"acl-xattr-mode-owner-group\",\"publicationLock\":\"recovery-flock-v1\",\"expectedIdentity\":\"main-device-inode-v1\",\"journalExec\":\"recovery-flock-v1\",\"journalPrivacy\":\"empty-directory-acl-v1\",\"draftJournalPrivacy\":\"retained-private-stage-v1\"}\n",TEST_HOOKS);return 0;}
    int drafts=argc==5 && strcmp(argv[1],"journal-exec-drafts")==0;
    int journal=argc==5 && (strcmp(argv[1],"journal-exec")==0 || drafts);
    if(!journal && (argc!=3 || (strcmp(argv[1],"write") && strcmp(argv[1],"inspect"))))return 2;
#ifdef ARYA_PERSISTENCE_TESTING
    fault=getenv("ARYA_TEST_FAULT");
#endif
    stage="directory";rootfd=select_root(argv[2]);struct stat rootstat;
    if(fstat(rootfd,&rootstat)<0)fail();require(S_ISDIR(rootstat.st_mode) && rootstat.st_uid==geteuid());
    uint64_t expected_device=read_u64(),expected_inode=read_u64();
    require((uint64_t)rootstat.st_dev==expected_device && (uint64_t)rootstat.st_ino==expected_inode);
    if(journal) {
        stage="journal";uint64_t node_device=read_u64(),node_inode=read_u64(),script_device=read_u64(),script_inode=read_u64();
        unsigned char expected_hash[CC_SHA256_DIGEST_LENGTH];read_exact(STDIN_FILENO,expected_hash,sizeof(expected_hash));
        int nodefd=open(argv[3],O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC),scriptfd=open(argv[4],O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if(nodefd<0 || scriptfd<0)fail();
        struct stat node_stat,script_stat,named;if(fstat(nodefd,&node_stat)<0 || fstat(scriptfd,&script_stat)<0)fail();
        require(S_ISREG(node_stat.st_mode) && node_stat.st_nlink==1 && (node_stat.st_mode & 0111) && !(node_stat.st_mode & 0022) && (node_stat.st_uid==0 || node_stat.st_uid==geteuid()) && (uint64_t)node_stat.st_dev==node_device && (uint64_t)node_stat.st_ino==node_inode);
        require(S_ISREG(script_stat.st_mode) && script_stat.st_nlink==1 && script_stat.st_size>0 && script_stat.st_size<=256*1024 && !(script_stat.st_mode & 0022) && (script_stat.st_uid==0 || script_stat.st_uid==geteuid()) && (uint64_t)script_stat.st_dev==script_device && (uint64_t)script_stat.st_ino==script_inode);
        const char *basename=strrchr(argv[4],'/');require(basename && strcmp(basename+1,"project-recovery-journal.mjs")==0);
        unsigned char bytes[65536],actual_hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256_CTX hash;CC_SHA256_Init(&hash);ssize_t count;size_t total=0;
        while((count=read(scriptfd,bytes,sizeof(bytes)))!=0) {if(count<0 && errno==EINTR)continue;if(count<0)fail();total+=(size_t)count;require(total<=256*1024);CC_SHA256_Update(&hash,bytes,(CC_LONG)count);}
        CC_SHA256_Final(actual_hash,&hash);require(total==(size_t)script_stat.st_size && memcmp(actual_hash,expected_hash,sizeof(expected_hash))==0);
        acquire_publication_lock(1);
        if(drafts) {
            draftfd=lock_directory(reelfd,"transcript-drafts",&draftstat);
            verify_directory_privacy(draftfd);
            if(fsync(draftfd)<0 || fsync(reelfd)<0)fail();
        }
        test_hook("lock-acquired");verify_publication_lock();verify_directory_privacy(recoveryfd);
        if(fstatat(AT_FDCWD,argv[3],&named,AT_SYMLINK_NOFOLLOW)<0)fail();require(unchanged(&node_stat,&named));
        if(fstatat(AT_FDCWD,argv[4],&named,AT_SYMLINK_NOFOLLOW)<0)fail();require(unchanged(&script_stat,&named));
        if(fcntl(lockfd,F_SETFD,0)<0)fail();char descriptor[32];snprintf(descriptor,sizeof(descriptor),"%d",lockfd);
        char device[32],inode[32];snprintf(device,sizeof(device),"%llu",(unsigned long long)expected_device);snprintf(inode,sizeof(inode),"%llu",(unsigned long long)expected_inode);
        char draft_descriptor[32];snprintf(draft_descriptor,sizeof(draft_descriptor),"%d",draftfd);
        char stage_descriptor[32],stage_snapshot[512];stage_descriptor[0]=0;stage_snapshot[0]=0;
        if(drafts) {
            struct stat held_draft,named_draft;
            if(fstat(draftfd,&held_draft)<0 || fstatat(reelfd,"transcript-drafts",&named_draft,AT_SYMLINK_NOFOLLOW)<0)fail();
            require(S_ISDIR(named_draft.st_mode) && unchanged(&draftstat,&held_draft) && unchanged(&draftstat,&named_draft));
            verify_directory_privacy(draftfd);
            create_private_draft_stage();
            test_hook("draft-stage-ready");
            struct stat held_stage,named_stage;
            if(fstat(draftstagefd,&held_stage)<0 || fstatat(draftfd,draftstagename,&named_stage,AT_SYMLINK_NOFOLLOW)<0)fail();
            require(unchanged(&draftstagestat,&held_stage) && unchanged(&draftstagestat,&named_stage) && named_stage.st_nlink==1);
            verify_directory_privacy(draftstagefd);
            if(fcntl(draftfd,F_SETFD,0)<0 || fcntl(draftstagefd,F_SETFD,0)<0)fail();
            snprintf(stage_descriptor,sizeof(stage_descriptor),"%d",draftstagefd);
            int length=snprintf(stage_snapshot,sizeof(stage_snapshot),"{\"device\":\"%llu\",\"inode\":\"%llu\",\"mode\":\"%u\",\"uid\":\"%u\",\"gid\":\"%u\",\"mtimeSec\":\"%lld\",\"mtimeNsec\":\"%lld\",\"ctimeSec\":\"%lld\",\"ctimeNsec\":\"%lld\"}",
              (unsigned long long)draftstagestat.st_dev,(unsigned long long)draftstagestat.st_ino,(unsigned int)draftstagestat.st_mode,(unsigned int)draftstagestat.st_uid,(unsigned int)draftstagestat.st_gid,
              (long long)draftstagestat.st_mtimespec.tv_sec,(long long)draftstagestat.st_mtimespec.tv_nsec,(long long)draftstagestat.st_ctimespec.tv_sec,(long long)draftstagestat.st_ctimespec.tv_nsec);
            require(length>0 && (size_t)length<sizeof(stage_snapshot));
        }
        char *child[]={argv[3],argv[4],argv[2],descriptor,device,inode,draft_descriptor,stage_descriptor,draftstagename,stage_snapshot,NULL};execv(argv[3],child);fail();
    }
    if(strcmp(argv[1],"inspect")==0) {
        stage="inspect";oldfd=openat(rootfd,"reel.project.json",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if(oldfd<0)fail();
        struct stat st;if(fstat(oldfd,&st)<0)fail();require(S_ISREG(st.st_mode) && st.st_size>=0 && (uint64_t)st.st_size<=MAX_DATA);
        CC_SHA256_CTX hash;CC_SHA256_Init(&hash);unsigned char bytes[65536],digest[CC_SHA256_DIGEST_LENGTH];ssize_t count;
        while((count=read(oldfd,bytes,sizeof(bytes)))!=0){if(count<0 && errno==EINTR)continue;if(count<0)fail();CC_SHA256_Update(&hash,bytes,(CC_LONG)count);}
        struct stat after,named;if(fstat(oldfd,&after)<0 || fstatat(rootfd,"reel.project.json",&named,AT_SYMLINK_NOFOLLOW)<0)fail();require(unchanged(&st,&after) && same_inode(&st,&named));
        CC_SHA256_Final(digest,&hash);char hex[65];for(int i=0;i<32;i++)sprintf(hex+i*2,"%02x",digest[i]);
        fprintf(stdout,"{\"ok\":true,\"protocol\":1,\"testHooks\":%s,\"sha256\":\"%s\"}\n",TEST_HOOKS,hex);cleanup();return 0;
    }
    stage="input";uint64_t size=read_u64(),previous_size=read_u64();require(size<=MAX_DATA && (previous_size==UINT64_MAX || previous_size<=MAX_DATA));
    uint64_t expected_target_device=read_u64(),expected_target_inode=read_u64();
    require(previous_size==UINT64_MAX ? expected_target_device==UINT64_MAX && expected_target_inode==UINT64_MAX : expected_target_device!=UINT64_MAX && expected_target_inode!=UINT64_MAX);
    char *data=malloc((size_t)size+1),*previous=previous_size==UINT64_MAX?NULL:malloc((size_t)previous_size+1);if(!data || (previous_size!=UINT64_MAX && !previous))fail();
    read_exact(STDIN_FILENO,data,(size_t)size);if(previous)read_exact(STDIN_FILENO,previous,(size_t)previous_size);
    char extra;ssize_t end;do{end=read(STDIN_FILENO,&extra,1);}while(end<0 && errno==EINTR);require(end==0);
    acquire_publication_lock(0);test_hook("lock-acquired");
    stage="target";struct stat oldstat;oldfd=openat(rootfd,"reel.project.json",O_RDWR|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    if(oldfd<0 && errno!=ENOENT)fail();
    if(oldfd>=0) {if(fstat(oldfd,&oldstat)<0)fail();require(S_ISREG(oldstat.st_mode) && oldstat.st_nlink==1 && oldstat.st_uid==geteuid() && !unsupported_flags(&oldstat) && !(oldstat.st_mode & 07000) && previous && (uint64_t)oldstat.st_dev==expected_target_device && (uint64_t)oldstat.st_ino==expected_target_inode);verify_expected(oldfd,previous,(size_t)previous_size);}
    else require(previous==NULL);
    stage="temporary";unsigned char random[16];arc4random_buf(random,sizeof(random));char hex[33];for(int i=0;i<16;i++)sprintf(hex+i*2,"%02x",random[i]);
    snprintf(tempname,sizeof(tempname),".reel-project-%s.tmp",hex);
    tempfd=openat(rootfd,tempname,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(tempfd<0)fail();
    if(fstat(tempfd,&tempstat)<0)fail();created=1;
    acl_t final_acl=NULL;char *final_acl_text=acl_text(oldfd>=0?oldfd:tempfd,&final_acl);
    acl_t empty=acl_init(0);if(!empty || acl_set_fd_np(tempfd,empty,ACL_TYPE_EXTENDED)<0)fail();acl_free(empty);
    if(fchmod(tempfd,0600)<0)fail();
    stage="write";
#ifdef ARYA_PERSISTENCE_TESTING
    if(fault && strcmp(fault,"partial-write")==0) {write_exact(tempfd,data,(size_t)size/2);_exit(73);}
#endif
    write_exact(tempfd,data,(size_t)size);
    stage="metadata";test_hook("metadata");
    if(oldfd>=0) {
        if(fchown(tempfd,oldstat.st_uid,oldstat.st_gid)<0)fail();
        if(fcopyfile(oldfd,tempfd,NULL,COPYFILE_XATTR)<0)fail();
    }
    test_hook("metadata-copied");
    // Install access restrictions before widening the populated temporary file's mode.
    if(acl_set_fd_np(tempfd,final_acl,ACL_TYPE_EXTENDED)<0)fail();acl_free(final_acl);
    verify_acl(tempfd,final_acl_text);
    if(oldfd>=0) {if(fchmod(tempfd,oldstat.st_mode & 0777)<0)fail();}
    else {mode_t mask=umask(0);umask(mask);if(fchmod(tempfd,0666 & ~mask)<0)fail();}
    test_hook("final-mode");
    struct stat ready;if(fstat(tempfd,&ready)<0)fail();
    require(S_ISREG(ready.st_mode) && ready.st_nlink==1 && !unsupported_flags(&ready) && ready.st_size>=0 && (uint64_t)ready.st_size==size);
    verify_acl(tempfd,final_acl_text);acl_free(final_acl_text);
    if(oldfd>=0)verify_xattrs(oldfd,tempfd);
    if(oldfd>=0)require(ready.st_uid==oldstat.st_uid && ready.st_gid==oldstat.st_gid && (ready.st_mode & 0777)==(oldstat.st_mode & 0777));
    verify_expected(tempfd,data,(size_t)size);
    stage="flush";if(fsync(tempfd)<0)fail();test_hook("file-flush");
    stage="conflict";struct stat named,current;
    if(oldfd>=0) {if(fstatat(rootfd,"reel.project.json",&named,AT_SYMLINK_NOFOLLOW)<0 || fstat(oldfd,&current)<0)fail();require(unchanged(&oldstat,&named) && unchanged(&oldstat,&current));verify_expected(oldfd,previous,(size_t)previous_size);}
    else {int found=fstatat(rootfd,"reel.project.json",&named,AT_SYMLINK_NOFOLLOW);require(found<0 && errno==ENOENT);}
    stage="rename";test_hook("rename");verify_publication_lock();
    if(fstatat(rootfd,tempname,&named,AT_SYMLINK_NOFOLLOW)<0 || fstat(tempfd,&current)<0)fail();require(unchanged(&ready,&named) && unchanged(&ready,&current) && named.st_nlink==1 && current.st_nlink==1);
    if(renameat(rootfd,tempname,rootfd,"reel.project.json")<0)fail();published=1;test_hook("replacement");
    int synced=fsync(rootfd)==0,code=synced?0:errno;
    fprintf(stdout,"{\"ok\":true,\"protocol\":1,\"testHooks\":%s,\"directorySynced\":%s,\"errno\":%d}\n",TEST_HOOKS,synced?"true":"false",code);
    cleanup();free(data);free(previous);return 0;
}
